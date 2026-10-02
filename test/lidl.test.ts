import {expect, test, vi} from "vitest";
import {definitions} from "../src/devices/lidl";
import {prepareDefinition} from "../src/index";
import type {Expose, KeyValueAny, Tz} from "../src/lib/types";
import {mockDevice} from "./utils";

const definition = prepareDefinition(definitions.find((d) => d.model === "HG06467"));
const exposes = definition.exposes as Expose[];
const sender = definition.toZigbee.find((c) => c.key.includes("effect"));
const receiver = definition.fromZigbee.find((c) => c.cluster === "manuSpecificTuya");
const palette = [
    {r: 255, g: 0, b: 0},
    {r: 0, g: 0, b: 255},
];

function device() {
    return mockDevice({modelID: "TS0601", manufacturerName: "_TZE200_s8gkrkxk", endpoints: [{ID: 1}]});
}

async function send(message: KeyValueAny, state: KeyValueAny = {}, triggerKey = Object.keys(message).find((key) => sender.key.includes(key))) {
    const dev = device();
    const entity = dev.getEndpoint(1);
    const meta = {message, state: {...state}, device: dev, mapped: definition, options: {}} as Tz.Meta;
    // Z2M invokes each SET converter once; its key order may differ from the JSON.
    const result = await sender.convertSet(entity, triggerKey, message[triggerKey], meta);
    if (result) Object.assign(meta.state, result.state);
    return {calls: vi.mocked(entity.command).mock.calls, state: meta.state as KeyValueAny};
}

async function rejects(message: KeyValueAny, state: KeyValueAny = {}, error?: string) {
    const entity = device().getEndpoint(1);
    const key = Object.keys(message)[0];
    const meta = {message, state: structuredClone(state)} as Tz.Meta;
    await expect(sender.convertSet(entity, key, message[key], meta), JSON.stringify(message)).rejects.toThrow(error);
    expect(entity.command).not.toHaveBeenCalled();
    expect(meta.state).toStrictEqual(state);
}

const dp = (id: number, datatype: number, data: number[] | Buffer) => ({dp: id, datatype, data: Buffer.from(data)});
function receive(dpValues: ReturnType<typeof dp>[], state: KeyValueAny = {}) {
    const dev = device();
    const msg = {device: dev, endpoint: dev.getEndpoint(1), data: {seq: 0, dpValues}, type: "commandDataReport"};
    return receiver.convert(definition, msg as Parameters<typeof receiver.convert>[1], vi.fn(), {}, {device: dev, state} as Parameters<
        typeof receiver.convert
    >[4]) as KeyValueAny;
}
const report = (...dpValues: ReturnType<typeof dp>[]) => receive(dpValues);
const packet = (call: unknown[]) => (call[2] as {dpValues: {dp: number; data: number[]}[]}).dpValues[0];
const text = (call: unknown[]) => Buffer.from(packet(call).data).toString("ascii");
const level = (call: unknown[]) => Buffer.from(packet(call).data).readUInt32BE();

test("all 16 effects use the legacy protocol IDs and decimal ASCII speed in both directions", async () => {
    const effects = ["steady", "snow", "rainbow", "snake", "twinkle", "firework", "horizontal_flag", "waves", "updown", "vintage"];
    effects.push("fading", "collide", "strobe", "sparkles", "carnaval", "glow");
    for (const [index, effect] of effects.entries()) {
        const id = index.toString(16).padStart(2, "0");
        // The legacy nested command remains an input adapter for the same encoder.
        const {calls, state} = await send({effect: {effect, speed: 100, colors: palette}});
        expect(packet(calls[0]).data[0]).toBe(2);
        expect(packet(calls[1]).dp).toBe(6);
        expect(text(calls[1])).toBe(`${id}64ff00000000ff`);
        expect(state.effect_name).toBe(effect);
        expect(report(dp(6, 3, Buffer.from(`${id}64ff00000000ff`))).effect_name).toBe(effect);
    }
});

test("multi-DP reports decode every DP including zeros; the reported mode wins", () => {
    expect(report(dp(2, 4, [1]), dp(5, 3, Buffer.from("0000000001f4")))).toStrictEqual({
        light_mode: "color",
        color_mode: "hs",
        color: {hue: 0, saturation: 0, h: 0, s: 0, b: 128},
        brightness: 127,
        color_brightness: 127,
    });
    expect(report(dp(3, 2, [0, 0, 3, 232])).brightness).toBe(254);
    // Without a known mode a color report selects HS; color.b keeps the legacy 0..255 scale.
    expect(report(dp(5, 3, Buffer.from("00f003e803e8")))).toMatchObject({color_mode: "hs", brightness: 254, color: {b: 255}});
    const effect = dp(6, 3, Buffer.from("0f64ff00000000ff"));
    expect(report(effect)).toMatchObject({effect_name: "glow", effect_speed: 100, gradient: ["#ff0000", "#0000ff"]});
    for (const values of [
        [effect, dp(2, 4, [0])],
        [dp(2, 4, [0]), effect],
    ]) {
        expect(report(...values)).toMatchObject({light_mode: "white", color_mode: "white", effect_name: "glow"});
    }
    // A report for the inactive color must not take over white mode or its brightness.
    const inactive = receive([dp(5, 3, Buffer.from("00f003e801f4"))], {light_mode: "white", white_brightness: 200});
    expect(inactive).toMatchObject({color_mode: "white", brightness: 200, color: {h: 240}});
    for (const value of [dp(6, 3, Buffer.from("zz64")), dp(5, 3, Buffer.from("000003e903e8")), dp(2, 4, [3]), dp(99, 4, [0])]) {
        expect(report(value)).toStrictEqual({});
    }
});

test("zero and full-scale values are encoded exactly, including the UI's 255", async () => {
    const zero = await send({color: {h: 0, s: 0, b: 0}}, {color: {h: 120, s: 90}, brightness: 200});
    expect(text(zero.calls[1])).toBe("000000000000");
    expect(zero.state).toMatchObject({light_mode: "color", brightness: 0, color: {hue: 0, saturation: 0}});
    for (const [brightness, expected] of [
        [0, 0],
        [127, 500],
        [254, 1000],
        [255, 1000],
    ]) {
        const {calls, state} = await send({light_mode: "white", brightness});
        expect(packet(calls[0]).data[0]).toBe(0);
        expect(packet(calls[1]).dp).toBe(3);
        expect(level(calls[1])).toBe(expected);
        expect(state.white_brightness).toBe(Math.min(brightness, 254));
    }
    expect(level((await send({white: 255})).calls[1])).toBe(1000);
    const full = await send({brightness: 255}, {light_mode: "color", color: {h: 120, s: 50}});
    expect(text(full.calls[1])).toBe("007801f403e8");
    expect(full.state.color_brightness).toBe(254);
    // The legacy hsb string keeps its 0..255 brightness scale; hue 360 wraps to 0.
    expect(text((await send({color: {hsb: "360,100,255"}})).calls[1])).toBe("000003e803e8");
});

test("brightness follows the white/color mode; combined color and brightness are sent once in any key order", async () => {
    const color = await send({brightness: 127}, {light_mode: "color", color: {h: 120, s: 50}});
    expect(packet(color.calls[0]).data[0]).toBe(1);
    expect(packet(color.calls[1]).dp).toBe(5);
    expect(text(color.calls[1])).toBe("007801f401f4");
    for (const message of [
        {brightness: 127, color: {hue: 240, saturation: 100}},
        {color: {hue: 240, saturation: 100}, brightness: 127},
    ]) {
        for (const key of ["brightness", "color"]) {
            const {calls} = await send(message, {light_mode: "effect"}, key);
            expect(calls.length).toBe(2);
            expect(text(calls[1])).toBe("00f003e801f4");
        }
    }
    // White and color remember their own brightness; HA's native white command selects white.
    const initial = {light_mode: "color", color: {h: 240, s: 100}, color_brightness: 127, white_brightness: 200};
    const white = await send({light_mode: "white"}, initial);
    expect(white.state).toMatchObject({color_mode: "white", brightness: 200, color: {h: 240, s: 100}});
    const back = await send({light_mode: "color"}, white.state);
    expect(back.state).toMatchObject({color_mode: "hs", brightness: 127});
    expect(text(back.calls[1])).toBe("00f003e801f4");
    const native = await send({white: 127}, initial);
    expect(native.state).toMatchObject({light_mode: "white", color_mode: "white"});
    expect(level(native.calls[1])).toBe(500);
    // Without a known mode, bare brightness still selects white.
    expect(packet((await send({brightness: 100})).calls[0]).data[0]).toBe(0);
});

test("invalid commands and brightness in effect mode are rejected before any device write", async () => {
    const active = (await send({effect_name: "horizontal_flag", effect_speed: 50, gradient: ["#ff0000", "#00ff00", "#0000ff"]})).state;
    for (const brightness of [0, 127, 255]) {
        await rejects({brightness}, active, "Brightness in effect mode is unsupported");
    }
    for (const message of [
        {light_mode: "effect", brightness: 100},
        {gradient: ["#ff0000"], brightness: 255},
        {effect: {effect: "missing"}},
        {effect: {speed: 101}},
        {effect: {colors: Array(7).fill(palette[0])}},
        {effect: {colors: [{r: 0.5, g: 0, b: 0}]}},
        {effect: {effect: "steady"}, effect_name: "twinkle"},
        {effect_name: "invalid"},
        {effect_color_1: "ff0000"},
        {gradient: []},
        {gradient: ["#ff0000"], effect_color_1: "#0000ff"},
        {color: {hue: 361}},
        {color: {hsv: "120,50,50"}},
        {color: {hsb: "0,,100"}},
        {light_mode: "white", brightness: 256},
        {white: 100, color: {h: 0}},
        {light_mode: "invalid"},
    ] as KeyValueAny[]) {
        await rejects(message);
    }
    // Leaving the effect stays possible with an explicit mode.
    expect((await send({white: 127}, active)).state.light_mode).toBe("white");
    expect((await send({color: {hue: 120, saturation: 100}, brightness: 127}, active)).state.light_mode).toBe("color");
});

test("effect, speed and palette controls keep each other's settings and round trip through reports", async () => {
    const selected = await send(
        {effect_name: "snake"},
        {light_mode: "effect", effect_name: "twinkle", effect_speed: 100, gradient: ["#ff0000", "#0000ff"]},
    );
    expect(text(selected.calls[1])).toBe("0364ff00000000ff");
    const speed = await send({effect_speed: 50}, selected.state);
    expect(text(speed.calls[1])).toBe("0332ff00000000ff");
    const edited = await send({effect_color_2: "#00FF80"}, speed.state);
    expect(text(edited.calls[1])).toBe("0332ff000000ff80");
    expect(report(dp(6, 3, Buffer.from(text(edited.calls[1]))))).toMatchObject({
        effect_name: "snake",
        effect_speed: 50,
        gradient: ["#ff0000", "#00ff80"],
        effect_color_2: "#00ff80",
    });
    // A later position is added without black gaps.
    const longer = await send({effect_color_6: "#FFFFFF"}, edited.state);
    expect(text(longer.calls[1])).toBe("0332ff000000ff80ffffff");
    expect(longer.state).toMatchObject({gradient: ["#ff0000", "#00ff80", "#ffffff"], effect_colors_on: [1, 2, 6]});
    // A shorter gradient switches later positions off; they keep their color.
    const shorter = await send({gradient: ["#800000"]}, longer.state);
    expect(text(shorter.calls[1])).toBe("0332800000");
    expect(shorter.state).toMatchObject({gradient: ["#800000"], effect_colors_on: [1], effect_color_2: "#00ff80", effect_color_6: "#ffffff"});
    // Settings survive leaving effect mode and can be edited from white.
    const white = await send({light_mode: "white"}, shorter.state);
    expect(white.state).toMatchObject({light_mode: "white", effect_name: "snake", gradient: ["#800000"]});
    const resumed = await send({effect_speed: 100}, white.state);
    expect(text(resumed.calls[1])).toBe("0364800000");
    expect(resumed.state.light_mode).toBe("effect");
});

test("palette positions switch off and on in place and keep their color", async () => {
    // A state from the previous revision (gradient only) migrates to positions 1..3.
    const previous = {light_mode: "effect", effect_name: "twinkle", effect_speed: 100, gradient: ["#ff0000", "#00ff00", "#0000ff"]};
    const off = await send({effect_color_2: "OFF"}, previous);
    expect(packet(off.calls[0]).data[0]).toBe(2);
    expect(text(off.calls[1])).toBe("0464ff00000000ff");
    expect(off.state).toMatchObject({gradient: ["#ff0000", "#0000ff"], effect_colors_on: [1, 3], effect_color_2: "#00ff00"});
    // The device reporting the sent palette keeps the switched-off position.
    expect(receive([dp(6, 3, Buffer.from("0464ff00000000ff"))], off.state)).toMatchObject({effect_colors_on: [1, 3], effect_color_2: "#00ff00"});
    // Any other reported palette fills positions 1..n; the others keep their color.
    expect(receive([dp(6, 3, Buffer.from("0464aaaaaa"))], off.state)).toMatchObject({effect_colors_on: [1], effect_color_3: "#0000ff"});
    const on = await send({effect_color_2: "ON"}, off.state);
    expect(text(on.calls[1])).toBe("0464ff000000ff000000ff");
    expect(on.state.effect_colors_on).toStrictEqual([1, 2, 3]);
    // HA sends ON again after a color edit: an unchanged position sends nothing.
    const again = await send({effect_color_2: "ON"}, on.state);
    expect(again.calls.length).toBe(0);
    expect(again.state).toStrictEqual(on.state);
    // A position that never had a color comes on white.
    const fresh = await send({effect_color_5: "ON"}, on.state);
    expect(fresh.state).toMatchObject({gradient: ["#ff0000", "#00ff00", "#0000ff", "#ffffff"], effect_colors_on: [1, 2, 3, 5]});
    const mixed = await send({effect_color_1: "OFF", effect_color_2: "#123456"}, on.state, "effect_color_1");
    expect(text(mixed.calls[1])).toBe("04641234560000ff");
});

test("outside effect mode ON/OFF only update the stored palette, also for bulk commands", async () => {
    let state: KeyValueAny = {light_mode: "white", effect_name: "twinkle", effect_speed: 100, gradient: ["#ff0000", "#00ff00", "#0000ff"]};
    // HA's "turn off all lights" sends OFF to every position separately.
    for (let i = 1; i <= 6; i++) {
        const update = await send({[`effect_color_${i}`]: "OFF"}, state);
        expect(update.calls.length).toBe(0);
        state = update.state;
    }
    expect(state).toMatchObject({light_mode: "white", gradient: [], effect_colors_on: [], effect_color_1: "#ff0000", effect_color_3: "#0000ff"});
    for (let i = 1; i <= 6; i++) {
        const update = await send({[`effect_color_${i}`]: "ON"}, state);
        expect(update.calls.length).toBe(0);
        state = update.state;
    }
    // Colors and mode survive; turning every position on also lights the empty ones white.
    expect(state).toMatchObject({light_mode: "white", effect_colors_on: [1, 2, 3, 4, 5, 6]});
    expect(state.gradient).toStrictEqual(["#ff0000", "#00ff00", "#0000ff", "#ffffff", "#ffffff", "#ffffff"]);
    // The stored palette is sent when the effect is selected.
    const effect = await send({light_mode: "effect"}, {...state, effect_colors_on: [1, 3]});
    expect(text(effect.calls[1])).toBe("0464ff00000000ff");
});

test("HA discovery: native white mode for the light, config RGB editors for palette entries", () => {
    const light: KeyValueAny = {schema: "json", brightness: true, supported_color_modes: ["hs"]};
    definition.meta.overrideHaDiscoveryPayload(light);
    expect(light).toMatchObject({supported_color_modes: ["hs", "white"], white_scale: 254, transition: false});
    const speed: KeyValueAny = {entity_category: "config", command_topic: "zigbee2mqtt/test/set/effect_speed"};
    definition.meta.overrideHaDiscoveryPayload(speed);
    expect(speed.entity_category).toBeUndefined();
    for (let i = 1; i <= 6; i++) {
        const key = `effect_color_${i}`;
        expect(exposes.find((entry) => entry.name === key).homeassistant).toStrictEqual({type: "light", entityCategory: "config"});
        const payload: KeyValueAny = {command_topic: `zigbee2mqtt/test/set/${key}`, state_topic: "zigbee2mqtt/test", value_template: "{{ x }}"};
        definition.meta.overrideHaDiscoveryPayload(payload);
        expect(payload).toMatchObject({
            schema: "basic",
            rgb_command_topic: payload.command_topic,
            rgb_state_topic: "zigbee2mqtt/test",
            payload_on: "ON",
            payload_off: "OFF",
            optimistic: false,
        });
        expect(payload.on_command_type).toBeUndefined();
        expect(payload.value_template).toBeUndefined();
        expect(payload.rgb_value_template).toContain(`value_json.get('${key}')`);
        expect(payload.state_value_template).toBe(`{{ 'ON' if ${i} in value_json.get('effect_colors_on', []) else 'OFF' }}`);
    }
    // A per-device `type: text` override gets a bounded HEX text entity instead.
    const hex: KeyValueAny = {command_topic: "zigbee2mqtt/test/set/effect_color_1"};
    definition.meta.overrideHaDiscoveryPayload(hex, {homeassistant: {effect_color_1: {type: "text"}}});
    expect(hex).toMatchObject({min: 7, max: 7});
    expect(new RegExp(hex.pattern).test("#ff0080")).toBe(true);
    const gradient = exposes.find((entry) => entry.name === "gradient");
    expect(gradient.type === "list" && [gradient.length_min, gradient.length_max]).toStrictEqual([1, 6]);
});

test("old nested effect state migrates to flat fields on ordinary reports without device writes", () => {
    const old: KeyValueAny = {
        light_mode: "white",
        color: {hue: 120, saturation: 80, h: 240, s: 10},
        effect: {effect: "twinkle", speed: 50, colors: palette},
    };
    const dev = device();
    const onOff = definition.fromZigbee.find((c) => c.cluster === "genOnOff");
    const msg = {data: {onOff: 1}, endpoint: dev.getEndpoint(1), device: dev, type: "readResponse"};
    const onOffUpdate = onOff.convert(definition, msg as Parameters<typeof onOff.convert>[1], vi.fn(), {}, {device: dev, state: old} as Parameters<
        typeof onOff.convert
    >[4]);
    for (const update of [onOffUpdate, receive([dp(2, 4, [0])], old)]) {
        const persisted = JSON.parse(JSON.stringify({...old, ...update}));
        expect(persisted).toMatchObject({
            light_mode: "white",
            color: {h: 120, s: 80},
            effect_name: "twinkle",
            effect_speed: 50,
            gradient: ["#ff0000", "#0000ff"],
            effect_colors_on: [1, 2],
        });
        expect(persisted).not.toHaveProperty("effect");
    }
    expect(dev.getEndpoint(1).command).not.toHaveBeenCalled();
});

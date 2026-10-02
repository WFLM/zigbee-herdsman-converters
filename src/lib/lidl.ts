import * as fz from "../converters/fromZigbee";
import * as tz from "../converters/toZigbee";
import * as exposes from "./exposes";
import * as tuya from "./tuya";

import type {Fz, KeyValueAny, ModernExtend, Tz} from "./types";

interface Rgb {
    r: number;
    g: number;
    b: number;
}
interface Slot {
    color?: Rgb;
    on: boolean;
}
interface EffectSettings {
    effect: string;
    speed: number;
    // Six fixed palette positions. A position that is off keeps its color but is not sent.
    slots: Slot[];
}

const e = exposes.presets;
const ea = exposes.access;
const modes = ["white", "color", "effect"];
const effects = [
    "steady",
    "snow",
    "rainbow",
    "snake",
    "twinkle",
    "firework",
    "horizontal_flag",
    "waves",
    "updown",
    "vintage",
    "fading",
    "collide",
    "strobe",
    "sparkles",
    "carnaval",
    "glow",
];
const paletteKeys = Array.from({length: 6}, (_, i) => `effect_color_${i + 1}`);
const effectKeys = ["effect_name", "effect_speed", "gradient", ...paletteKeys];
const keys = ["light_mode", "brightness", "white", "color", "effect", ...effectKeys];
const hex = (value: number, width: number) => value.toString(16).padStart(width, "0");
const scale = (value: number, from: number, to: number) => Math.round((value * to) / from);
const red: Rgb = {r: 255, g: 0, b: 0};
const white: Rgb = {r: 255, g: 255, b: 255};
const isBlack = (color: Rgb) => color.r === 0 && color.g === 0 && color.b === 0;
const activeColors = (slots: Slot[]) => slots.filter((slot) => slot.on).map((slot) => slot.color);
const isSwitch = (value: unknown) => value === "ON" || value === "OFF";

function number(value: unknown, min: number, max: number, name: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${name} must be a number between ${min} and ${max}`);
    }
    return value;
}

function object(value: unknown, name: string): KeyValueAny {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
    return value as KeyValueAny;
}

function rgbHex(color: Rgb) {
    return `#${hex(color.r, 2)}${hex(color.g, 2)}${hex(color.b, 2)}`;
}

function parseHex(value: unknown, name: string): Rgb {
    if (typeof value !== "string" || !/^#[\da-f]{6}$/i.test(value)) {
        throw new Error(`${name} must be a hex RGB color, e.g. #ff8000`);
    }
    return {r: Number.parseInt(value.slice(1, 3), 16), g: Number.parseInt(value.slice(3, 5), 16), b: Number.parseInt(value.slice(5, 7), 16)};
}

function colorPayload(value: unknown, state: KeyValueAny, brightness?: unknown) {
    const input = {...object(value, "color")};
    if (input.hsb !== undefined) {
        if (typeof input.hsb !== "string" || !/^\s*\d+(\.\d+)?\s*,\s*\d+(\.\d+)?\s*,\s*\d+(\.\d+)?\s*$/.test(input.hsb)) {
            throw new Error("color.hsb must contain three numbers: hue,saturation,brightness");
        }
        [input.h, input.s, input.b] = input.hsb.split(",").map(Number);
    }
    if (!["h", "hue", "s", "saturation", "b", "brightness"].some((key) => input[key] !== undefined)) {
        throw new Error("color requires hue/saturation or h/s/b (RGB, XY, HSV and HSL are not supported)");
    }
    const old = state.color ?? {};
    const hue = Math.round(number(input.h ?? input.hue ?? old.hue ?? old.h ?? 0, 0, 360, "hue")) % 360;
    const saturation = number(input.s ?? input.saturation ?? old.saturation ?? old.s ?? 100, 0, 100, "saturation");
    // Retain the legacy b/brightness/hsb scale of 0..255. Public brightness is 0..254.
    const level =
        brightness !== undefined
            ? scale(number(brightness, 0, 254, "brightness"), 254, 1000)
            : input.b !== undefined || input.brightness !== undefined
              ? scale(number(input.b ?? input.brightness, 0, 255, "color brightness"), 255, 1000)
              : scale(number(state.brightness ?? 254, 0, 255, "cached brightness"), 254, 1000);
    const boundedLevel = Math.min(level, 1000); // Accept the old converter's cached 255.
    return {
        data: hex(hue, 4) + hex(scale(saturation, 100, 1000), 4) + hex(boundedLevel, 4),
        state: {
            color_mode: "hs",
            color: {hue, saturation, h: hue, s: saturation, b: scale(boundedLevel, 1000, 255)},
            brightness: scale(boundedLevel, 1000, 254),
            color_brightness: scale(boundedLevel, 1000, 254),
        },
    };
}

function rgb(value: unknown): Rgb {
    const color = object(value, "RGB color");
    const channel = (name: keyof Rgb) => {
        const level = number(color[name], 0, 255, `color.${name}`);
        if (!Number.isInteger(level)) throw new Error(`color.${name} must be an integer`);
        return level;
    };
    return {r: channel("r"), g: channel("g"), b: channel("b")};
}

// A list of colors fills positions 1..n; later positions are switched off but keep their color.
function fillSlots(colors: Rgb[], previous?: Slot[]): Slot[] {
    return paletteKeys.map((_, i) => (i < colors.length ? {color: colors[i], on: true} : {color: previous?.[i]?.color, on: false}));
}

const slotsKey = (slots: Slot[]) => slots.map((slot) => `${slot.on}${slot.color ? rgbHex(slot.color) : ""}`).join();

function effectSettings(value: unknown, previous?: EffectSettings): EffectSettings {
    const input = object(value, "effect");
    const name = input.effect ?? previous?.effect ?? "steady";
    if (!effects.includes(name)) throw new Error(`Unknown effect: ${name}`);
    // Zero was accepted by the legacy implementation and remains valid.
    const speed = number(input.speed ?? previous?.speed ?? 50, 0, 100, "effect.speed");
    let slots: Slot[] = input.slots ?? previous?.slots;
    if (input.colors !== undefined || !slots) {
        const colors = input.colors ?? [red];
        if (!Array.isArray(colors) || colors.length > 6) throw new Error("effect.colors must be an array of 0..6 RGB colors");
        slots = fillSlots(colors.map(rgb), previous?.slots);
    }
    return {effect: name, speed, slots};
}

function effectPayload(value: unknown, previous?: EffectSettings) {
    const settings = effectSettings(value, previous);
    const speedRaw = scale(settings.speed, 100, 64);
    // Effect ID and RGB channels are hexadecimal; speed is DECIMAL ASCII.
    return {
        data:
            hex(effects.indexOf(settings.effect), 2) +
            String(speedRaw).padStart(2, "0") +
            activeColors(settings.slots)
                .map((c) => hex(c.r, 2) + hex(c.g, 2) + hex(c.b, 2))
                .join(""),
        state: {...settings, speed: scale(speedRaw, 64, 100)},
    };
}

function effectState(settings: EffectSettings) {
    const state: KeyValueAny = {
        effect_name: settings.effect,
        effect_speed: settings.speed,
        // The palette sent to the device, for Z2M's gradient editor.
        gradient: activeColors(settings.slots).map(rgbHex),
        effect_colors_on: settings.slots.flatMap((slot, i) => (slot.on ? [i + 1] : [])),
    };
    // HA discovery would insert nulls for missing properties, so a position
    // without a color is published as black (and is never on).
    for (const [i, key] of paletteKeys.entries()) {
        const color = settings.slots[i].color;
        state[key] = color ? rgbHex(color) : "#000000";
    }
    return state;
}

function cachedEffect(state: KeyValueAny): EffectSettings | undefined {
    // Canonical fields also survive a Z2M restart.
    try {
        if (state.effect_name !== undefined && state.effect_speed !== undefined) {
            const base = {effect: state.effect_name, speed: state.effect_speed};
            if (Array.isArray(state.effect_colors_on)) {
                const on: unknown[] = state.effect_colors_on;
                if (on.some((n) => !Number.isInteger(n) || (n as number) < 1 || (n as number) > 6)) throw new Error("Invalid effect_colors_on");
                const slots = paletteKeys.map((key, i) => {
                    const color = state[key] === undefined ? undefined : parseHex(state[key], key);
                    const enabled = on.includes(i + 1);
                    if (enabled && !color) throw new Error(`${key} is on without a color`);
                    // Black stands for "no color" unless the position is on.
                    return {color: enabled || (color && !isBlack(color)) ? color : undefined, on: enabled};
                });
                return effectSettings({...base, slots});
            }
            // Earlier revisions stored only the sent palette.
            if (Array.isArray(state.gradient)) {
                return effectSettings({...base, colors: state.gradient.map((color) => parseHex(color, "gradient color"))});
            }
        }
        // Read the old upstream cache once, without publishing its nested format.
        if (state.effect_name === undefined && state.effect !== undefined) return effectSettings(state.effect);
    } catch {
        // Invalid persisted settings must not block light commands or a new palette.
        // New SET values are validated separately and still fail before device writes.
    }
    return undefined;
}

function effectInput(message: KeyValueAny, previous?: EffectSettings) {
    if (message.effect !== undefined && effectKeys.some((key) => message[key] !== undefined)) {
        throw new Error("Choose the effect object or the flat effect controls in one command");
    }
    if (message.gradient !== undefined && paletteKeys.some((key) => message[key] !== undefined)) {
        throw new Error("Choose gradient or individual palette entries in one command");
    }
    // The legacy nested command is only an input adapter to the same encoder.
    const input = {...(message.effect === undefined ? {} : object(message.effect, "effect"))};
    if (message.effect_name !== undefined) input.effect = message.effect_name;
    if (message.effect_speed !== undefined) input.speed = message.effect_speed;
    if (message.gradient !== undefined) {
        if (!Array.isArray(message.gradient) || message.gradient.length < 1 || message.gradient.length > 6) {
            throw new Error("gradient must be an array of 1..6 HEX colors");
        }
        input.colors = message.gradient.map((value: unknown) => parseHex(value, "gradient color"));
    }
    if (paletteKeys.some((key) => message[key] !== undefined)) {
        const slots = (previous?.slots ?? fillSlots([red])).map((slot) => ({...slot}));
        for (const [i, key] of paletteKeys.entries()) {
            const value = message[key];
            if (value === undefined) continue;
            // OFF leaves a position out without forgetting its color; ON brings it back
            // (white if it never had one). A HEX value sets and enables the position.
            if (value === "OFF") {
                slots[i].on = false;
            } else if (value === "ON") {
                const color = slots[i].color;
                if (!slots[i].on) slots[i] = {color: color && !isBlack(color) ? color : white, on: true};
            } else {
                slots[i] = {color: parseHex(value, `${key} (or ON/OFF)`), on: true};
            }
        }
        input.slots = slots;
    }
    return input;
}

function presentation(state: KeyValueAny, effect: EffectSettings | undefined) {
    const result: KeyValueAny = {};
    // Z2M merges updates into its cache. Undefined replaces obsolete values and
    // is omitted from both published JSON and persisted state, unlike null.
    if (state.effect !== undefined) result.effect = undefined;
    if (state.light_mode) result.color_mode = state.light_mode === "white" ? "white" : "hs";
    if (state.color) {
        const hue = state.color.hue ?? state.color.h;
        const saturation = state.color.saturation ?? state.color.s;
        if (hue !== undefined && saturation !== undefined) result.color = {...state.color, hue, saturation, h: hue, s: saturation};
    }
    if (effect) Object.assign(result, effectState(effect));
    return result;
}

const fromOnOff: Fz.Converter<"genOnOff", undefined, ["attributeReport", "readResponse"]> = {
    ...fz.on_off,
    convert: (model, msg, publish, options, meta) => {
        const result = fz.on_off.convert(model, msg, publish, options, meta);
        // Also refresh presentation on an ordinary on/off read/report after an upgrade.
        const state = meta.state ?? {};
        return result ? {...presentation(state, cachedEffect(state)), ...result} : result;
    },
};

const toLight: Tz.Converter = {
    key: keys,
    convertSet: async (entity, key, value, meta) => {
        const message: KeyValueAny = {...(meta.message ?? {[key]: value})};
        // Z2M invokes each SET converter once and may reorder keys. Always handle
        // the complete message, regardless of which key triggered this call.
        // Z2M's percentage presets use 0..255 despite the exposed max of 254.
        // Accept exactly 255 as full output; keep every other validation intact.
        if (message.brightness === 255) message.brightness = 254;
        if (message.white === 255) message.white = 254;
        const state: KeyValueAny = meta.state ?? {};
        // HA switches palette positions with plain ON/OFF, also for "turn off all lights".
        // Outside effect mode this only updates the stored palette for the next effect,
        // so it never changes the mode or the light output; unchanged positions send nothing.
        const switchesOnly = keys.every((k) => message[k] === undefined || (paletteKeys.includes(k) && isSwitch(message[k])));
        if (switchesOnly && paletteKeys.some((k) => isSwitch(message[k]))) {
            const previous = cachedEffect(state);
            const next = effectSettings(effectInput(message, previous), previous);
            if (previous && slotsKey(previous.slots) === slotsKey(next.slots)) return;
            if (state.light_mode !== "effect") return {state: presentation(state, next)};
        }
        const hasEffect = message.effect !== undefined || effectKeys.some((key) => message[key] !== undefined);
        if (message.white !== undefined) {
            number(message.white, 0, 254, "white");
            if (message.color !== undefined || hasEffect || (message.light_mode && message.light_mode !== "white")) {
                throw new Error("white conflicts with color/effect/light_mode");
            }
            message.light_mode = "white";
            message.brightness = message.white;
        }
        let mode = message.light_mode;
        if (mode !== undefined && !modes.includes(mode)) throw new Error("light_mode must be white, color or effect");
        if (message.color !== undefined && hasEffect) throw new Error("Choose color or effect in one command");
        const requested = hasEffect ? "effect" : message.color !== undefined ? "color" : undefined;
        if (mode && requested && mode !== requested) throw new Error("light_mode conflicts with color/effect");
        // Brightness must not leave an active effect. White remains the fallback
        // when no mode is known; switching modes requires an explicit command.
        mode = mode ?? requested ?? state.light_mode ?? "white";
        if (mode === "effect" && message.brightness !== undefined) {
            throw new Error("Brightness in effect mode is unsupported; select white/color or edit the effect RGB palette");
        }

        // Validate/encode everything before sending even the mode command.
        let payload: string | number;
        let effect = cachedEffect(state);
        let result: KeyValueAny = {light_mode: mode, color_mode: mode === "white" ? "white" : "hs"};
        if (mode === "color") {
            const encoded = colorPayload(
                message.color ?? {h: state.color?.hue ?? state.color?.h ?? 0},
                {...state, brightness: state.color_brightness ?? state.brightness},
                message.brightness,
            );
            payload = encoded.data;
            result = {...result, ...encoded.state};
        } else if (mode === "effect") {
            const encoded = effectPayload(effectInput(message, effect), effect);
            payload = encoded.data;
            effect = encoded.state;
        } else {
            if (message.brightness !== undefined) {
                payload = scale(number(message.brightness, 0, 254, "brightness"), 254, 1000);
                result.brightness = scale(payload, 1000, 254);
                result.white_brightness = result.brightness;
            } else if (state.white_brightness !== undefined) {
                result.brightness = state.white_brightness;
            }
        }
        // Retain settings across modes and migrate old caches in the same update.
        result = {...presentation({...state, ...result}, effect), ...result};
        await tuya.sendDataPointEnum(entity, 2, modes.indexOf(mode));
        if (mode === "white" && typeof payload === "number") await tuya.sendDataPointValue(entity, 3, payload);
        if (typeof payload === "string") {
            await tuya.sendDataPointStringBuffer(entity, mode === "color" ? 5 : 6, payload);
        }
        return {state: result};
    },
};

const fromLight: Fz.Converter<"manuSpecificTuya", undefined, ["commandDataResponse", "commandDataReport"]> = {
    cluster: "manuSpecificTuya",
    type: ["commandDataResponse", "commandDataReport"],
    convert: (_model, msg, _publish, _options, meta) => {
        const result: KeyValueAny = {};
        let reported: {effect: string; speed: number; colors: Rgb[]} | undefined;
        // A single report may contain several DPs; do not discard all but the first.
        for (const {dp, datatype, data} of msg.data.dpValues ?? []) {
            const buffer = Buffer.from(data);
            const text = buffer.toString("ascii");
            if (dp === 2 && datatype === 4 && buffer.length === 1 && modes[buffer[0]]) {
                result.light_mode = modes[buffer[0]];
            } else if (dp === 3 && datatype === 2 && buffer.length === 4) {
                const level = buffer.readUInt32BE();
                if (level <= 1000) result.white_brightness = scale(level, 1000, 254);
            } else if (dp === 5 && datatype === 3 && /^[\da-f]{12}$/i.test(text)) {
                const [hue, saturation, level] = [0, 4, 8].map((offset) => Number.parseInt(text.slice(offset, offset + 4), 16));
                if (hue > 360 || saturation > 1000 || level > 1000) continue;
                result.color = {hue: hue % 360, saturation: saturation / 10, h: hue % 360, s: saturation / 10, b: scale(level, 1000, 255)};
                result.color_brightness = scale(level, 1000, 254);
            } else if (dp === 6 && datatype === 3 && /^[\da-f]{2}\d{2}(?:[\da-f]{6}){0,6}$/i.test(text)) {
                const name = effects[Number.parseInt(text.slice(0, 2), 16)];
                const speed = Number.parseInt(text.slice(2, 4), 10);
                if (!name || speed > 64) continue;
                const colors: Rgb[] = [];
                for (let i = 4; i < text.length; i += 6) {
                    colors.push({
                        r: Number.parseInt(text.slice(i, i + 2), 16),
                        g: Number.parseInt(text.slice(i + 2, i + 4), 16),
                        b: Number.parseInt(text.slice(i + 4, i + 6), 16),
                    });
                }
                reported = {effect: name, speed: scale(speed, 64, 100), colors};
            }
        }
        if (!reported && Object.keys(result).length === 0) return result;
        // Mode wins even when inactive color/brightness/effect DPs arrive later.
        const previous = meta?.state ?? {};
        const cached = cachedEffect(previous);
        let effect = cached;
        if (reported) {
            // Reporting the palette that was sent keeps the switched-off positions;
            // any other palette fills positions 1..n.
            const sent = cached ? activeColors(cached.slots).map(rgbHex).join() : undefined;
            const slots = sent === reported.colors.map(rgbHex).join() ? cached.slots : fillSlots(reported.colors, cached?.slots);
            effect = {effect: reported.effect, speed: reported.speed, slots};
        }
        const mode = result.light_mode ?? previous.light_mode;
        if (mode) result.color_mode = mode === "white" ? "white" : "hs";
        else if (result.color) result.color_mode = "hs";
        if (mode === "white") {
            const brightness = result.white_brightness ?? previous.white_brightness;
            if (brightness !== undefined) result.brightness = brightness;
        } else if (mode === "color") {
            const brightness = result.color_brightness ?? previous.color_brightness;
            if (brightness !== undefined) result.brightness = brightness;
        } else if (!mode) {
            const brightness = result.color_brightness ?? result.white_brightness;
            if (brightness !== undefined) result.brightness = brightness;
        }
        return {...presentation({...previous, ...result}, effect), ...result};
    },
};

export function hg06467(): ModernExtend {
    const light = e.light_brightness_colorhs().setAccess("brightness", ea.STATE_SET).setAccess("color_hs", ea.STATE_SET);
    light.features.find((feature) => feature.name === "brightness").withDescription("Brightness in white/color mode. Not supported in effect mode.");

    return {
        isModernExtend: true,
        meta: {
            overrideHaDiscoveryPayload: (payload, options = {}) => {
                // Effect speed is a primary light control, not device configuration.
                if (payload.command_topic?.endsWith("/set/effect_speed")) delete payload.entity_category;
                if (payload.schema === "json" && payload.brightness) {
                    payload.supported_color_modes = ["hs", "white"];
                    payload.white_scale = 254;
                    payload.transition = false;
                }
                const palette = typeof payload.command_topic === "string" && /\/set\/(effect_color_[1-6])$/.exec(payload.command_topic);
                if (palette && (options.homeassistant?.[palette[1]]?.type ?? "light") === "light") {
                    const key = palette[1];
                    const readColor = `{% set c = value_json.get('${key}') or '#000000' %}`;
                    // Reuse the existing HEX command and state fields through HA's native
                    // RGB light editor; these represent palette entries, not extra hardware.
                    delete payload.value_template;
                    delete payload.pattern;
                    delete payload.min;
                    delete payload.max;
                    payload.schema = "basic";
                    payload.rgb_command_topic = payload.command_topic;
                    payload.rgb_state_topic = payload.state_topic;
                    payload.rgb_command_template = "{{ '#%02x%02x%02x' | format(red, green, blue) }}";
                    payload.rgb_value_template = `${readColor}{{ c[1:3] | int(0, 16) }},{{ c[3:5] | int(0, 16) }},{{ c[5:7] | int(0, 16) }}`;
                    // HA's default on_command_type ("last") sends ON after an RGB edit, or alone
                    // for a plain turn on. ON/OFF switch the position; it keeps its color while off.
                    payload.payload_on = "ON";
                    payload.payload_off = "OFF";
                    payload.state_value_template = `{{ 'ON' if ${key.slice(-1)} in value_json.get('effect_colors_on', []) else 'OFF' }}`;
                    payload.optimistic = false;
                    payload.icon = "mdi:palette";
                } else if (palette) {
                    payload.pattern = "^#[0-9a-fA-F]{6}$";
                    payload.min = 7;
                    payload.max = 7;
                }
            },
        },
        fromZigbee: [fromOnOff, fromLight],
        toZigbee: [tz.on_off, toLight],
        exposes: [
            light,
            e.enum("light_mode", ea.STATE_SET, modes).withDescription("White light, static color, or animated effect"),
            e
                .enum("effect_name", ea.STATE_SET, effects)
                .withLabel("Effect")
                .withDescription("Select a built-in effect and enter effect mode. Retains speed and palette."),
            e
                .numeric("effect_speed", ea.STATE_SET)
                .withValueMin(0)
                .withValueMax(100)
                .withValueStep(1)
                .withHomeAssistant({enabledByDefault: true})
                .withDescription("Animation speed (device resolution: 0..64). Setting this enters effect mode."),
            // The name selects Z2M's native RGB palette editor. SET-only avoids an
            // extra read-only HA sensor; state is still supplied for the frontend.
            e
                .list("gradient", ea.SET, e.text("color", ea.SET))
                .withLengthMin(1)
                .withLengthMax(6)
                .withLabel("Effect palette")
                .withDescription(
                    "Effect colors. Add/remove colors and press Apply. Fills positions 1..N and switches later positions off. Enters effect mode; keeps effect and speed.",
                ),
            ...paletteKeys.map((key) =>
                e
                    .text(key, ea.STATE_SET)
                    // Applied before discovery topics are chosen; no per-device overrides.
                    // Config entities are excluded from area/device targets and voice assistants.
                    .withHomeAssistant({type: "light", entityCategory: "config"})
                    .withDescription(
                        "Palette position as #RRGGBB (e.g. #ff8000), ON or OFF. A color enables the position and enters effect mode. OFF leaves it out of the effect and keeps its color; outside effect mode ON/OFF only update the stored palette.",
                    ),
            ),
        ],
    };
}

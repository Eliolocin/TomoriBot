import { describe, expect, it } from "bun:test";
import {
  getDefaultSpeechEndpointSettings,
  readSpeechEndpointSettings,
  speechEndpointSettingsFromSubmittedValues,
} from "@/utils/provider/customSpeechEndpointSettings";

describe("custom speech endpoint settings", () => {
  it("defaults a clone server to plain text and ElevenLabs to bracket tags", () => {
    expect(getDefaultSpeechEndpointSettings("tts-clone")).toEqual({
      voiceMode: "clone",
      scriptMarkup: "plain",
      supportsInstruct: false,
    });
    expect(getDefaultSpeechEndpointSettings("elevenlabs")).toEqual({
      voiceMode: "clone",
      scriptMarkup: "bracket-tags",
      supportsInstruct: false,
    });
  });

  it("reads stored values and falls back per api style when a key is absent or invalid", () => {
    expect(
      readSpeechEndpointSettings({
        api_style: "tts-clone",
        extra_config: { voice_mode: "auto", script_markup: "emoji" },
      }),
    ).toEqual({ voiceMode: "auto", scriptMarkup: "emoji", supportsInstruct: true });

    expect(
      readSpeechEndpointSettings({
        api_style: "tts-clone",
        extra_config: { voice_mode: "nonsense", script_markup: 7 },
      }),
    ).toEqual({ voiceMode: "clone", scriptMarkup: "plain", supportsInstruct: false });

    expect(readSpeechEndpointSettings({ api_style: "elevenlabs", extra_config: {} }).scriptMarkup).toBe("bracket-tags");
  });

  it("implies instruct support from VoiceDesign and Auto without the explicit tick", () => {
    expect(
      speechEndpointSettingsFromSubmittedValues("tts-clone", "voice-design", "plain", undefined).supportsInstruct,
    ).toBe(true);
    expect(speechEndpointSettingsFromSubmittedValues("tts-clone", "auto", "plain", []).supportsInstruct).toBe(true);
    expect(speechEndpointSettingsFromSubmittedValues("tts-clone", "clone", "plain", []).supportsInstruct).toBe(false);
    expect(
      speechEndpointSettingsFromSubmittedValues("tts-clone", "clone", "plain", ["supports-instruct"]).supportsInstruct,
    ).toBe(true);
  });

  it("ignores a submitted voice mode for an api style that has no clone/design split", () => {
    expect(
      speechEndpointSettingsFromSubmittedValues("elevenlabs", "voice-design", "bracket-tags", ["supports-instruct"]),
    ).toEqual({ voiceMode: "clone", scriptMarkup: "bracket-tags", supportsInstruct: true });
  });
});

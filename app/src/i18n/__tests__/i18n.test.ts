import { act, renderHook } from "@testing-library/react-native";
import { DEFAULT_LANGUAGE, useI18nValue } from "../index";

describe("useI18nValue", () => {
  it("starts with the given initial language and resolves keys", async () => {
    const { result } = await renderHook(() => useI18nValue("en"));
    expect(result.current.language).toBe("en");
    expect(result.current.t("chat.send")).toBe("Send");
  });

  it("defaults to English when the app has never had a language set", () => {
    expect(DEFAULT_LANGUAGE).toBe("en");
  });

  it("switches the resolved strings when the language changes", async () => {
    const { result } = await renderHook(() => useI18nValue("en"));
    await act(async () => {
      result.current.setLanguage("es");
    });
    expect(result.current.language).toBe("es");
    expect(result.current.t("chat.send")).toBe("Enviar");
  });

  it("interpolates params into a template string", async () => {
    const { result } = await renderHook(() => useI18nValue("en"));
    expect(result.current.t("chat.undoneSome", { count: 3 })).toBe("Reverted 3 change(s).");
  });

  it("falls back to the key itself for a missing path, never throwing", async () => {
    const { result } = await renderHook(() => useI18nValue("en"));
    // @ts-expect-error -- deliberately an invalid key, to assert the safe fallback
    expect(result.current.t("not.a.real.key")).toBe("not.a.real.key");
  });
});

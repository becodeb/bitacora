import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSettings } from "../src/features/settings/settings-context";
import { useI18n } from "../src/i18n/index";
import { radius, spacing, typography, useColors } from "../src/theme/tokens";

export default function SettingsScreen() {
  const colors = useColors();
  const { t, language, setLanguage } = useI18n();
  const settings = useSettings();
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [token, setToken] = useState(settings.token);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    const failure = await settings.connect(baseUrl, token);
    setSaving(false);
    if (failure === "unreachable") {
      setError(t("onboarding.errorUnreachable"));
    } else if (failure === "unauthorized") {
      setError(t("onboarding.errorUnauthorized"));
    } else {
      setSaved(true);
    }
  };

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.container}
    >
      <Text style={[typography.title, { color: colors.textPrimary }]}>{t("settings.title")}</Text>

      <Text style={[typography.label, { color: colors.textSecondary }]}>
        {t("settings.serverUrlLabel")}
      </Text>
      <TextInput
        value={baseUrl}
        onChangeText={setBaseUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={[styles.input, { borderColor: colors.border, color: colors.textPrimary }]}
        testID="settings-base-url"
      />

      <Text style={[typography.label, { color: colors.textSecondary }]}>
        {t("settings.tokenLabel")}
      </Text>
      <TextInput
        value={token}
        onChangeText={setToken}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        style={[styles.input, { borderColor: colors.border, color: colors.textPrimary }]}
        testID="settings-token"
      />

      {error ? (
        <Text style={{ color: colors.danger, marginBottom: spacing.sm }}>{error}</Text>
      ) : null}
      {saved ? (
        <Text style={{ color: colors.accent, marginBottom: spacing.sm }}>
          {t("settings.saved")}
        </Text>
      ) : null}

      <Pressable
        onPress={handleSave}
        disabled={saving}
        style={[styles.button, { backgroundColor: colors.accent }]}
        testID="settings-save"
      >
        <Text style={{ color: colors.accentText, fontWeight: "600" }}>{t("common.save")}</Text>
      </Pressable>

      <Text style={[typography.label, { color: colors.textSecondary, marginTop: spacing.xl }]}>
        {t("settings.languageLabel")}
      </Text>
      <View style={styles.languageRow}>
        <Pressable
          onPress={() => setLanguage("en")}
          style={[
            styles.languagePill,
            {
              borderColor: colors.border,
              backgroundColor: language === "en" ? colors.accent : "transparent",
            },
          ]}
          testID="settings-language-en"
        >
          <Text style={{ color: language === "en" ? colors.accentText : colors.textPrimary }}>
            {t("settings.languageEnglish")}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setLanguage("es")}
          style={[
            styles.languagePill,
            {
              borderColor: colors.border,
              backgroundColor: language === "es" ? colors.accent : "transparent",
            },
          ]}
          testID="settings-language-es"
        >
          <Text style={{ color: language === "es" ? colors.accentText : colors.textPrimary }}>
            {t("settings.languageSpanish")}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.xl,
  },
  input: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
  },
  button: {
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  languageRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  languagePill: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
});

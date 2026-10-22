import { Redirect } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";
import { useSettings } from "../src/features/settings/settings-context";
import { DEFAULT_BASE_URL } from "../src/features/settings/settings-store";
import { useI18n } from "../src/i18n/index";
import { radius, spacing, typography, useColors } from "../src/theme/tokens";

export default function OnboardingScreen() {
  const colors = useColors();
  const { t } = useI18n();
  const { configured, connect } = useSettings();
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [token, setToken] = useState("");
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (configured) {
    return <Redirect href="/(tabs)/chat" />;
  }

  const handleConnect = async () => {
    setValidating(true);
    setError(null);
    const failure = await connect(baseUrl, token);
    setValidating(false);
    if (failure === "unreachable") {
      setError(t("onboarding.errorUnreachable"));
    } else if (failure === "unauthorized") {
      setError(t("onboarding.errorUnauthorized"));
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Text style={[typography.title, { color: colors.textPrimary }]}>{t("onboarding.title")}</Text>
      <Text
        style={[typography.bodySmall, { color: colors.textSecondary, marginBottom: spacing.lg }]}
      >
        {t("onboarding.subtitle")}
      </Text>

      <Text style={[typography.label, { color: colors.textSecondary }]}>
        {t("onboarding.serverUrlLabel")}
      </Text>
      <TextInput
        value={baseUrl}
        onChangeText={setBaseUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={[styles.input, { borderColor: colors.border, color: colors.textPrimary }]}
        testID="onboarding-base-url"
      />

      <Text style={[typography.label, { color: colors.textSecondary }]}>
        {t("onboarding.tokenLabel")}
      </Text>
      <TextInput
        value={token}
        onChangeText={setToken}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        style={[styles.input, { borderColor: colors.border, color: colors.textPrimary }]}
        testID="onboarding-token"
      />

      {error ? (
        <Text style={[typography.bodySmall, { color: colors.danger, marginTop: spacing.sm }]}>
          {error}
        </Text>
      ) : null}

      <Pressable
        onPress={handleConnect}
        disabled={validating || baseUrl.trim().length === 0 || token.trim().length === 0}
        style={[styles.button, { backgroundColor: colors.accent, marginTop: spacing.lg }]}
        testID="onboarding-connect"
      >
        {validating ? (
          <>
            <ActivityIndicator color={colors.accentText} />
            <Text style={{ color: colors.accentText, marginLeft: spacing.sm }}>
              {t("onboarding.validating")}
            </Text>
          </>
        ) : (
          <Text style={{ color: colors.accentText, fontWeight: "600" }}>
            {t("onboarding.connect")}
          </Text>
        )}
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: spacing.xl,
    justifyContent: "center",
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
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    paddingVertical: spacing.md,
  },
});

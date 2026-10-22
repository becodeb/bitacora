import { Text } from "react-native";
import { useColors } from "../../../theme/tokens";

const CITATION_PATTERN = /\[#(\w+)\]/g;

export interface CitationTextProps {
  text: string;
  citations: Record<string, string>;
  onCitationPress: (ref: string, sourceEntryId: string) => void;
  textStyle?: object;
}

/**
 * Renders message text, turning any `[#n]` marker into a tappable
 * chip when `citations` has a mapping for it (a message built live
 * this session) and leaving it as plain text otherwise (a message
 * loaded from history — see `features/chat/types.ts`'s `UiMessage`
 * doc for why history has no mapping to tap).
 */
export function CitationText({ text, citations, onCitationPress, textStyle }: CitationTextProps) {
  const colors = useColors();
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  for (const match of text.matchAll(CITATION_PATTERN)) {
    if (match.index === undefined) {
      continue;
    }
    if (match.index > lastIndex) {
      parts.push(
        <Text key={key++} style={[{ color: colors.textPrimary }, textStyle]}>
          {text.slice(lastIndex, match.index)}
        </Text>,
      );
    }

    const ref = match[1];
    const sourceEntryId = citations[ref];
    if (sourceEntryId) {
      parts.push(
        <Text
          key={key++}
          accessibilityRole="button"
          accessibilityLabel={`citation ${match[0]}`}
          onPress={() => onCitationPress(ref, sourceEntryId)}
          testID={`citation-chip-${ref}`}
          style={{ color: colors.accent, fontWeight: "600" }}
        >
          {match[0]}
        </Text>,
      );
    } else {
      parts.push(
        <Text key={key++} style={[{ color: colors.textSecondary }, textStyle]}>
          {match[0]}
        </Text>,
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(
      <Text key={key++} style={[{ color: colors.textPrimary }, textStyle]}>
        {text.slice(lastIndex)}
      </Text>,
    );
  }

  return <Text style={textStyle}>{parts}</Text>;
}

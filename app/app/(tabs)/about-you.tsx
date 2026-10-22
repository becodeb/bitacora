import { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ChangeRow } from "../../src/features/about-you/components/change-row";
import { MemoryRow } from "../../src/features/about-you/components/memory-row";
import { RuleRow } from "../../src/features/about-you/components/rule-row";
import { TopicHeader } from "../../src/features/about-you/components/topic-header";
import { TopicRow } from "../../src/features/about-you/components/topic-row";
import { useChanges } from "../../src/features/about-you/use-changes";
import { useRules } from "../../src/features/about-you/use-rules";
import { useTopicDetail } from "../../src/features/about-you/use-topic-detail";
import { useTopics } from "../../src/features/about-you/use-topics";
import { CitationSheet } from "../../src/features/chat/components/citation-sheet";
import { useCitationEntry } from "../../src/features/chat/use-citation-entry";
import { useSettings } from "../../src/features/settings/settings-context";
import { useI18n } from "../../src/i18n/index";
import { spacing, typography, useColors } from "../../src/theme/tokens";

type Tab = "topics" | "rules" | "changes";
type TopicsView = { kind: "list" } | { kind: "detail"; topicId: string | null };

/**
 * "What I know about you" (T10 work unit (c)): topics with their live
 * memories, rules, and a Changes history with per-group Undo. Every
 * edit here applies immediately — no confirmation dialogs, per
 * `odd/tasks/mvp.md`'s owner decision — and memories show a tappable
 * source citation reusing the chat's own `CitationSheet`.
 */
export default function AboutYouScreen() {
  const { t } = useI18n();
  const colors = useColors();
  const { client } = useSettings();
  const [tab, setTab] = useState<Tab>("topics");
  const [topicsView, setTopicsView] = useState<TopicsView>({ kind: "list" });

  const topicsList = useTopics(client);
  const rules = useRules(client);
  const changes = useChanges(client);
  const citationEntry = useCitationEntry(client);
  const topicDetail = useTopicDetail(
    client,
    topicsView.kind === "detail" ? topicsView.topicId : undefined,
  );

  const otherTopics =
    topicsView.kind === "detail"
      ? topicsList.topics.filter((topicItem) => topicItem.id !== topicsView.topicId)
      : [];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {tab === "topics" && topicsView.kind === "detail" ? null : (
        <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
          {(["topics", "rules", "changes"] as const).map((candidate) => (
            <Pressable
              key={candidate}
              onPress={() => setTab(candidate)}
              style={styles.tabButton}
              testID={`about-you-tab-${candidate}`}
            >
              <Text
                style={[
                  typography.body,
                  { color: tab === candidate ? colors.accent : colors.textSecondary },
                ]}
              >
                {t(
                  `aboutYou.tab${candidate.charAt(0).toUpperCase()}${candidate.slice(1)}` as never,
                )}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {tab === "topics" ? (
        topicsView.kind === "list" ? (
          <FlatList
            data={topicsList.topics}
            keyExtractor={(item) => item.id}
            refreshControl={
              <RefreshControl refreshing={topicsList.refreshing} onRefresh={topicsList.refresh} />
            }
            ListHeaderComponent={
              <TopicRow
                topic={{
                  id: "__none__",
                  name: t("aboutYou.noTopicBucket"),
                  description: null,
                  summary: null,
                  liveMemoryCount: 0,
                  lastChangeAt: new Date(0).toISOString(),
                }}
                memoryCountLabel=""
                onPress={() => setTopicsView({ kind: "detail", topicId: null })}
              />
            }
            ListEmptyComponent={
              topicsList.loading ? (
                <ActivityIndicator style={styles.spinner} color={colors.accent} />
              ) : (
                <Text
                  style={[
                    typography.bodySmall,
                    { color: colors.textSecondary, padding: spacing.lg },
                  ]}
                >
                  {topicsList.error
                    ? topicsList.error === "network"
                      ? t("aboutYou.errorNetwork")
                      : t("aboutYou.errorGeneric")
                    : t("aboutYou.topicsEmpty")}
                </Text>
              )
            }
            renderItem={({ item }) => (
              <TopicRow
                topic={item}
                memoryCountLabel={t("aboutYou.memoryCount", { count: item.liveMemoryCount })}
                onPress={() => setTopicsView({ kind: "detail", topicId: item.id })}
              />
            )}
          />
        ) : (
          <>
            <TopicHeader
              topic={
                topicDetail.topic ?? {
                  id: "__none__",
                  name: t("aboutYou.noTopicBucket"),
                  description: null,
                  summary: null,
                  liveMemoryCount: topicDetail.memories.length,
                  lastChangeAt: new Date(0).toISOString(),
                }
              }
              backLabel={t("aboutYou.back")}
              renameLabel={t("aboutYou.rename")}
              saveLabel={t("common.save")}
              cancelLabel={t("common.cancel")}
              onBack={() => {
                setTopicsView({ kind: "list" });
                void topicsList.refresh();
              }}
              onRename={(name) => {
                if (topicsView.kind === "detail" && topicsView.topicId) {
                  void topicsList.renameTopic(topicsView.topicId, name);
                  void topicDetail.refresh();
                }
              }}
            />
            <FlatList
              data={topicDetail.memories}
              keyExtractor={(item) => item.id}
              refreshControl={
                <RefreshControl
                  refreshing={topicDetail.refreshing}
                  onRefresh={topicDetail.refresh}
                />
              }
              ListEmptyComponent={
                topicDetail.loading ? (
                  <ActivityIndicator style={styles.spinner} color={colors.accent} />
                ) : (
                  <Text
                    style={[
                      typography.bodySmall,
                      { color: colors.textSecondary, padding: spacing.lg },
                    ]}
                  >
                    {topicDetail.error
                      ? topicDetail.error === "network"
                        ? t("aboutYou.errorNetwork")
                        : t("aboutYou.errorGeneric")
                      : t("aboutYou.memoriesEmpty")}
                  </Text>
                )
              }
              renderItem={({ item }) => (
                <MemoryRow
                  memory={item}
                  otherTopics={otherTopics}
                  editLabel={t("aboutYou.memoryEdit")}
                  saveLabel={t("aboutYou.memorySave")}
                  cancelLabel={t("aboutYou.memoryCancel")}
                  moveLabel={t("aboutYou.memoryMove")}
                  moveToNoTopicLabel={t("aboutYou.memoryMoveToNone")}
                  deleteLabel={t("aboutYou.memoryDelete")}
                  citationLabel={t("aboutYou.memoryCitation")}
                  onSaveContent={(content) => void topicDetail.editMemoryContent(item.id, content)}
                  onMove={(newTopicId) => void topicDetail.moveMemory(item.id, newTopicId)}
                  onDelete={() => void topicDetail.deleteMemory(item.id)}
                  onOpenCitation={() => citationEntry.openCitation(item.sourceEntryId)}
                />
              )}
            />
          </>
        )
      ) : null}

      {tab === "rules" ? (
        <FlatList
          data={rules.rules}
          keyExtractor={(item) => item.key}
          refreshControl={
            <RefreshControl refreshing={rules.refreshing} onRefresh={rules.refresh} />
          }
          ListEmptyComponent={
            rules.loading ? (
              <ActivityIndicator style={styles.spinner} color={colors.accent} />
            ) : (
              <Text
                style={[typography.bodySmall, { color: colors.textSecondary, padding: spacing.lg }]}
              >
                {rules.error
                  ? rules.error === "network"
                    ? t("aboutYou.errorNetwork")
                    : t("aboutYou.errorGeneric")
                  : t("aboutYou.rulesEmpty")}
              </Text>
            )
          }
          renderItem={({ item }) => (
            <RuleRow
              rule={item}
              editLabel={t("aboutYou.ruleEdit")}
              saveLabel={t("aboutYou.ruleSave")}
              cancelLabel={t("aboutYou.ruleCancel")}
              deleteLabel={t("aboutYou.ruleDelete")}
              invalidJsonLabel={t("aboutYou.ruleInvalidJson")}
              onSavePayload={(payload) =>
                void rules.saveRule(item.key, payload, item.topicName ?? undefined)
              }
              onDelete={() => void rules.deleteRule(item.key)}
            />
          )}
        />
      ) : null}

      {tab === "changes" ? (
        <>
          {changes.lastUndoResult ? (
            <View style={[styles.snackbar, { backgroundColor: colors.surfaceAlt }]}>
              <Text style={[typography.bodySmall, { color: colors.textPrimary }]}>
                {t("aboutYou.changeUndoSnackbar", { count: changes.lastUndoResult.reverted })}
              </Text>
              <Pressable onPress={changes.dismissUndoResult}>
                <Text style={{ color: colors.accent }}>{t("common.close")}</Text>
              </Pressable>
            </View>
          ) : null}
          <FlatList
            data={changes.changes}
            keyExtractor={(item) => item.groupId}
            refreshControl={
              <RefreshControl refreshing={changes.refreshing} onRefresh={changes.refresh} />
            }
            ListEmptyComponent={
              changes.loading ? (
                <ActivityIndicator style={styles.spinner} color={colors.accent} />
              ) : (
                <Text
                  style={[
                    typography.bodySmall,
                    { color: colors.textSecondary, padding: spacing.lg },
                  ]}
                >
                  {changes.error
                    ? changes.error === "network"
                      ? t("aboutYou.errorNetwork")
                      : t("aboutYou.errorGeneric")
                    : t("aboutYou.changesEmpty")}
                </Text>
              )
            }
            renderItem={({ item }) => (
              <ChangeRow
                change={item}
                undoLabel={t("aboutYou.changeUndo")}
                undoneLabel={t("aboutYou.changeUndone")}
                undoing={changes.undoingGroupId === item.groupId}
                onUndo={() => void changes.undo(item.groupId)}
              />
            )}
          />
        </>
      ) : null}

      <CitationSheet
        visible={citationEntry.open}
        loading={citationEntry.loading}
        entry={citationEntry.entry}
        error={citationEntry.error}
        title={t("chat.citationsSheetTitle")}
        closeLabel={t("common.close")}
        onClose={citationEntry.close}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  tabBar: {
    flexDirection: "row",
    borderBottomWidth: 1,
  },
  tabButton: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacing.md,
  },
  spinner: {
    padding: spacing.xl,
  },
  snackbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    borderRadius: spacing.sm,
  },
});

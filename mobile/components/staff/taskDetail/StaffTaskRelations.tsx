import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import * as Linking from "expo-linking";
import { type Href, useRouter } from "expo-router";
import { staffStyles } from "@/components/staff/staffStyles";
import { Button } from "@/components/ui";
import type { StaffTaskDetail } from "@/lib/api.staff";
import { relationHref } from "@/lib/staffUi";
import { colors } from "@/lib/theme";

export function StaffTaskRelations({
  relations,
  canEdit,
  onLink,
}: {
  relations: StaffTaskDetail["relations"];
  canEdit: boolean;
  onLink: (kind: string, targetId: string, label?: string) => void;
}) {
  const router = useRouter();
  const [kind, setKind] = useState("clip");
  const [target, setTarget] = useState("");

  function open(row: StaffTaskDetail["relations"][number]) {
    const href = relationHref(row.kind, row.targetId, row.label);
    if (!href) return;
    if (href.startsWith("http")) {
      void Linking.openURL(href);
      return;
    }
    router.push(href as Href);
  }

  return (
    <View style={staffStyles.sectionCard}>
      <Text style={staffStyles.cardTitle}>Relations</Text>
      {relations.map((row) => (
        <Pressable key={row.id} style={staffStyles.hubRow} onPress={() => open(row)}>
          <View>
            <Text style={staffStyles.hubLabel}>{row.label || row.targetId}</Text>
            <Text style={staffStyles.hubHint}>{row.kind}</Text>
          </View>
        </Pressable>
      ))}
      {relations.length === 0 ? <Text style={staffStyles.muted}>No related Replayr items.</Text> : null}
      {canEdit ? (
        <>
          <View style={staffStyles.row}>
            {["clip", "url"].map((value) => (
              <Pressable key={value} style={[staffStyles.pill, kind === value && staffStyles.pillOn]} onPress={() => setKind(value)}>
                <Text style={[staffStyles.pillText, kind === value && staffStyles.pillTextOn]}>{value}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            style={staffStyles.input}
            value={target}
            onChangeText={setTarget}
            placeholder={kind === "url" ? "https://…" : "Clip slug or id"}
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
          />
          <Button
            label="Link"
            kind="primary"
            disabled={!target.trim()}
            onPress={() => {
              const value = target.trim();
              onLink(kind, value, kind === "url" ? value : undefined);
              setTarget("");
            }}
          />
        </>
      ) : null}
    </View>
  );
}

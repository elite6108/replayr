import { Text, View } from "react-native";
import { staffStyles } from "@/components/staff/staffStyles";
import { formatTimeAgo } from "@/lib/format";
import { activityHeadline } from "@/lib/staffActivityCopy";
import type { StaffTaskDetail } from "@/lib/api.staff";

export function StaffTaskActivity({
  activity,
  columns,
}: {
  activity: StaffTaskDetail["activity"];
  columns?: Array<{ id: string; name: string }>;
}) {
  return (
    <View style={staffStyles.sectionCard}>
      <Text style={staffStyles.cardTitle}>Activity</Text>
      {activity.map((item) => (
        <Text key={item.id} style={staffStyles.muted}>
          {activityHeadline(item, columns)} · {formatTimeAgo(item.createdAt)}
        </Text>
      ))}
      {activity.length === 0 ? <Text style={staffStyles.muted}>No activity yet.</Text> : null}
    </View>
  );
}

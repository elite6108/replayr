import { ReactNode } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { folderStyles } from "@/components/folders/folderStyles";

export function FolderSheetFrame({
  visible,
  title,
  onClose,
  footer,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={folderStyles.overlay}>
        <Pressable style={folderStyles.dismiss} onPress={onClose} />
        <View style={[folderStyles.sheet, { paddingBottom: Math.max(16, insets.bottom + 8) }]}>
          <View style={folderStyles.handle} />
          <View style={[folderStyles.row, { justifyContent: "space-between", marginBottom: 12 }]}>
            <Text style={folderStyles.sheetTitle}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={{ color: "#7fd0ef", fontWeight: "700" }}>Done</Text>
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12, paddingBottom: 8 }}>
            {children}
          </ScrollView>
          {footer ? <View style={{ gap: 8, paddingTop: 8 }}>{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}

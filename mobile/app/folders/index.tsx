import { Redirect } from "expo-router";
import { foldersHref } from "@/lib/api.folders";

export default function LegacyFoldersRedirect() {
  return <Redirect href={foldersHref()} />;
}

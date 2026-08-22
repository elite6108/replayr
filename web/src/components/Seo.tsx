import { useEffect } from "react";
import { setSeo } from "../lib/seo";

export function Seo({ title, description, robots }: { title: string; description: string; robots?: string }) {
  useEffect(() => {
    setSeo(title, description, robots);
  }, [title, description, robots]);
  return null;
}

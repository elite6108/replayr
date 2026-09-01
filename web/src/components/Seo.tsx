import { useEffect } from "react";
import { setSeo } from "../lib/seo";

export function Seo({
  title,
  description,
  robots,
  image,
}: {
  title: string;
  description: string;
  robots?: string;
  image?: string | null;
}) {
  useEffect(() => {
    setSeo(title, description, robots, image);
  }, [title, description, robots, image]);
  return null;
}

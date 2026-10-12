import { OG_ALT, OG_SIZE, ogImage } from "@/components/OgImage";

export const alt = OG_ALT;
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return ogImage();
}

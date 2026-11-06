/**
 * Simple marks for the places a video or short is posted, in each platform's
 * own colours, so the Publish dialog looks like where the text is going.
 * The markup is fixed here (never built from user text).
 */
const marks: Record<string, string> = {
  youtube:
    '<rect x="1.5" y="4.5" width="21" height="15" rx="4.5" fill="#FF0000"/><path d="M10 8.9v6.2l5.4-3.1Z" fill="#fff"/>',
  x: '<rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="#000"/><path d="M6.2 6h3.3l8.3 12h-3.3Z" fill="#fff"/><path d="M17.4 6 6.6 18" stroke="#fff" stroke-width="1.5" fill="none"/>',
  reddit:
    '<circle cx="12" cy="12" r="10.5" fill="#FF4500"/><circle cx="6.3" cy="11.3" r="1.6" fill="#fff"/><circle cx="17.7" cy="11.3" r="1.6" fill="#fff"/><ellipse cx="12" cy="13.4" rx="5.9" ry="4.2" fill="#fff"/><circle cx="9.7" cy="12.8" r="1.1" fill="#FF4500"/><circle cx="14.3" cy="12.8" r="1.1" fill="#FF4500"/><path d="M9.6 15.4c1.4 1 3.4 1 4.8 0" stroke="#FF4500" stroke-width="1" stroke-linecap="round" fill="none"/><path d="M12 9.2 12.9 5.6l3.1.7" stroke="#fff" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="16.8" cy="6.4" r="1.3" fill="#fff"/>',
  linkedin:
    '<rect x="1.5" y="1.5" width="21" height="21" rx="4.5" fill="#0A66C2"/><circle cx="7.6" cy="7.7" r="1.5" fill="#fff"/><rect x="6.3" y="10.2" width="2.6" height="7.6" fill="#fff"/><path d="M11 10.2h2.5v1.1c.5-.8 1.4-1.3 2.6-1.3 2.200 0 3 1.400 3 3.600v4.200h-2.600v-3.600c0-1-.3-1.700-1.300-1.700s-1.600.7-1.600 1.800v3.500H11Z" fill="#fff"/>',
  discord:
    '<rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#5865F2"/><path d="M7.4 8.2C8.7 7.6 10.200 7.300 12 7.300s3.300.3 4.600.9c1.300 1.900 2 4.100 2.100 6.500-1 .8-2.100 1.200-3.100 1.500l-.7-1.200c.4-.1.800-.3 1.100-.5l-.4-.3c-1.800.8-3.900.8-5.700 0l-.4.300c.3.200.7.400 1.100.5l-.7 1.200c-1-.3-2.100-.7-3.100-1.500.1-2.400.8-4.600 2.100-6.500Z" fill="#fff"/><circle cx="9.700" cy="12.500" r="1.100" fill="#5865F2"/><circle cx="14.300" cy="12.500" r="1.100" fill="#5865F2"/>',
};

/** Fills every `[data-brand-logo]` inside the root with its platform's mark. */
export function fillPlatformLogos(root: ParentNode): void {
  for (const slot of root.querySelectorAll<HTMLElement>("[data-brand-logo]")) {
    const mark = marks[slot.dataset.brandLogo ?? ""];
    if (mark)
      slot.innerHTML = `<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true" focusable="false">${mark}</svg>`;
  }
}

// Searchable emoji set for the Scratchpad, ported from the dashboard dialog.
// Each entry pairs a glyph with space-separated search keywords.

export const EMOJI_GROUPS = [
  { category: "Often used", items: [
    ["✅", "check done tick complete"], ["❌", "x cross no fail"], ["⚠️", "warning caution"],
    ["🔥", "fire hot lit"], ["✨", "sparkles new shine"], ["🎉", "tada party celebrate"],
    ["🚀", "rocket ship launch ship it"], ["💡", "idea bulb tip"], ["📌", "pin pinned important"],
    ["⭐", "star favourite favorite important"], ["🐛", "bug defect"], ["🛠️", "tools fix repair wrench"],
    ["📝", "memo note write"], ["📅", "calendar date schedule"], ["⏰", "alarm clock reminder time"],
    ["🎯", "target goal focus"]
  ]},
  { category: "Faces", items: [
    ["😊", "smile happy"], ["😄", "grin happy laugh"], ["🙂", "slight smile ok"],
    ["😅", "sweat smile phew"], ["😂", "joy laugh tears"], ["🤔", "thinking hmm"],
    ["😐", "neutral meh"], ["😴", "sleep tired"], ["🥳", "party face celebrate"],
    ["😎", "cool sunglasses"], ["🤯", "mind blown wow"], ["😬", "grimace awkward"],
    ["🙃", "upside down sarcasm"], ["🫠", "melting overwhelmed"], ["🤝", "handshake deal agree"]
  ]},
  { category: "Gestures", items: [
    ["👍", "thumbs up yes approve"], ["👎", "thumbs down no reject"], ["👏", "clap applause"],
    ["🙌", "raised hands hooray"], ["🙏", "please thanks pray"], ["💪", "strong muscle"],
    ["👀", "eyes look review"], ["👋", "wave hello bye"], ["🤞", "fingers crossed hope"]
  ]},
  { category: "Work", items: [
    ["💻", "laptop code dev"], ["🖥️", "desktop monitor"], ["⌨️", "keyboard typing"],
    ["📱", "phone mobile"], ["📊", "chart metrics graph"], ["📈", "chart up growth"],
    ["📉", "chart down decline"], ["🗂️", "folders files organise"], ["📁", "folder directory"],
    ["🔗", "link url"], ["🔒", "lock secure private"], ["🔑", "key access"],
    ["🧪", "test experiment lab"], ["⚙️", "gear settings config"], ["🧹", "broom cleanup"],
    ["📦", "package build release"], ["🏷️", "tag label"], ["📋", "clipboard list copy"]
  ]},
  { category: "Symbols", items: [
    ["✔️", "check tick yes"], ["➕", "plus add"], ["➖", "minus remove"],
    ["➡️", "arrow right next"], ["⬅️", "arrow left back"], ["⬆️", "arrow up"],
    ["⬇️", "arrow down"], ["🔄", "refresh sync repeat"], ["⏳", "hourglass waiting pending"],
    ["🚧", "construction wip blocked"], ["❓", "question unknown"], ["❗", "exclamation important"],
    ["💬", "comment chat"], ["📣", "megaphone announce"]
  ]}
];

export const ALL_EMOJI = EMOJI_GROUPS.flatMap(group =>
  group.items.map(([char, keywords]) => ({ char, keywords, category: group.category }))
);

// Keyword/substring search; an empty query returns the full grouped list.
export function filterEmoji(query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return ALL_EMOJI;
  return ALL_EMOJI.filter(item => item.keywords.includes(needle) || item.char === needle);
}

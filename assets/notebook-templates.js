// Notebook prompt templates — extended starter library for the prompt creator.
// Each starter fills the same FIELDS as the original prompt-creator.js: task, role, context, audience, tone, rules, length, scope, format, examples, steps.
// We re-export STARTERS compatibility plus EXTENDED.

export const NOTEBOOK_STARTERS = {
  summary: { task: "Summarize {{document}} into key claims, evidence, and open questions.", role: "Research analyst", context: "{{document}}", audience: "Decision makers", tone: "Concise", format: "Bullet Points", rules: "Do not invent facts. Distinguish claims from verified evidence.", length: "At most 250 words", scope: "Only use {{document}}", examples: "", steps: "" },
  review: { task: "Review {{code}} for correctness, security, and maintainability.", role: "Senior Engineer", context: "{{code}}", audience: "Engineering team", tone: "Technical", format: "Markdown Table", rules: "Prioritize actionable findings with severity and evidence. Do not claim to have executed the code.", length: "", scope: "Source review only", examples: "", steps: "" },
  extract: { task: "Extract [fields] from {{source}}.", role: "Data extraction specialist", context: "{{source}}", audience: "Data consumers", tone: "Concise", format: "JSON", rules: "Return null for missing values. Do not infer unsupported facts.", length: "", scope: "", examples: "", steps: "" },
  draft: { task: "Draft {{deliverable}} about {{topic}}.", role: "Copywriter", context: "{{background}}", audience: "[audience]", tone: "Persuasive", format: "Markdown", rules: "Avoid unsupported claims and respect scope.", length: "", scope: "", examples: "", steps: "" },

  // ---- new starters ----
  meeting: { task: "Turn {{notes}} into structured meeting notes with decisions, owners, and next steps.", role: "Executive assistant", context: "Raw notes:\n{{notes}}\n\nAttendees: {{attendees}}", audience: "Meeting participants", tone: "Concise", format: "Markdown", rules: "Use headings: Summary, Decisions, Action items (owner + due), Open questions. No invented attendees.", length: "Under 400 words", scope: "Only use provided notes", examples: "", steps: "" },
  research: { task: "Create a research outline for {{topic}} with questions, sources to check, and evaluation criteria.", role: "Research lead", context: "Topic: {{topic}}\nGoal: {{goal}}", audience: "Research team", tone: "Neutral", format: "Markdown", rules: "List 5-8 key questions, 3-5 source types, and how to judge evidence quality.", length: "", scope: "Outline only, no full answers", examples: "", steps: "" },
  blog: { task: "Write an outline and first draft for a blog post titled \"{{title}}\" about {{topic}}.", role: "Content strategist", context: "Audience: {{audience}}\nKey points: {{points}}", audience: "{{audience}}", tone: "Conversational", format: "Markdown", rules: "Start with a hook. End with a takeaway. No unsupported statistics.", length: "~600 words", scope: "{{scope}}", examples: "", steps: "" },
  decision: { task: "Create an ADR (Architecture Decision Record) for {{decision}} with context, options, and consequences.", role: "Staff Engineer", context: "Decision: {{decision}}\nContext: {{context}}", audience: "Engineering team", tone: "Formal", format: "Markdown", rules: "Include: Status, Context, Decision, Alternatives considered, Consequences. Be specific.", length: "", scope: "", examples: "", steps: "" },
  story: { task: "Write a user story and acceptance criteria for {{feature}}.", role: "Product manager", context: "Feature: {{feature}}\nUser: {{user}}\nContext: {{context}}", audience: "Engineering + Design", tone: "Concise", format: "Bullet Points", rules: "Format: As a [user] I want [goal] so that [benefit]. Include 3-6 Given/When/Then criteria.", length: "", scope: "", examples: "", steps: "" },
  brainstorm: { task: "Brainstorm 12 varied ideas for {{challenge}} grouped into themes.", role: "Facilitator", context: "Challenge: {{challenge}}\nConstraints: {{constraints}}", audience: "Creative team", tone: "Persuasive", format: "Bullet Points", rules: "Quantity over quality first. No idea longer than one sentence. Include 2 wild cards.", length: "", scope: "", examples: "", steps: "" },
  plan: { task: "Create a project plan for {{project}} with milestones, owners, and risks.", role: "Project manager", context: "Project: {{project}}\nTimeline: {{timeline}}\nTeam: {{team}}", audience: "Stakeholders", tone: "Formal", format: "Markdown Table", rules: "Break into phases. For each milestone list owner, due, and dependencies. Flag top 3 risks.", length: "", scope: "", examples: "", steps: "" },
  journal: { task: "Turn bullet points {{bullets}} into a reflective daily journal entry.", role: "Writing coach", context: "Bullets:\n{{bullets}}\nMood: {{mood}}", audience: "Self", tone: "Conversational", format: "Markdown", rules: "Warm, first-person. Highlight one win and one intention for tomorrow. No toxic positivity.", length: "200-300 words", scope: "", examples: "", steps: "" },
  email: { task: "Draft an email to {{recipient}} about {{subject}} with clear ask and context.", role: "Executive communicator", context: "Background: {{context}}\nAsk: {{ask}}", audience: "{{recipient}}", tone: "Formal", format: "Plain Text", rules: "Subject line + greeting + 2-3 short paragraphs + explicit ask + sign-off. Respectful and direct.", length: "Under 180 words", scope: "", examples: "", steps: "" },
  study: { task: "Create a study guide for {{topic}} with key concepts, examples, and self-check questions.", role: "Teacher", context: "Topic: {{topic}}\nLevel: {{level}}\nSource material: {{material}}", audience: "Learners at {{level}}", tone: "Neutral", format: "Markdown", rules: "For each concept: definition + example + common misconception. End with 5 quiz questions and answers.", length: "", scope: "", examples: "", steps: "" },
  expand: { task: "Expand the outline section \"{{section}}\" into detailed, well-structured content.", role: "Expert writer", context: "Section title: {{section}}\nCurrent content:\n{{content}}\n\nGoal: {{goal}}", audience: "General readers", tone: "Neutral", format: "Markdown", rules: "Keep the original heading. Use sub-headings, bullets, and examples. Do not hallucinate references.", length: "300-500 words", scope: "Stay within this section's topic", examples: "", steps: "" },
  tldr: { task: "Produce TL;DR and key takeaways for {{document}}.", role: "Editor", context: "{{document}}", audience: "Busy readers", tone: "Concise", format: "Bullet Points", rules: "TL;DR is one sentence. Then 3-5 takeaways, each one line. No new claims.", length: "Under 120 words", scope: "", examples: "", steps: "" },
};

export const STARTER_CATEGORIES = {
  Core: ["summary", "review", "extract", "draft"],
  "Capture & Plan": ["meeting", "research", "brainstorm", "plan"],
  "Writing": ["blog", "email", "journal", "tldr"],
  "Product & Engineering": ["story", "decision", "study", "expand"]
};

export const STARTER_LABELS = {
  summary: "Summarization", review: "Code Review", extract: "Extraction", draft: "Drafting",
  meeting: "Meeting Notes", research: "Research Outline", blog: "Blog Post", decision: "Decision Log (ADR)",
  story: "User Story", brainstorm: "Brainstorm", plan: "Project Plan", journal: "Daily Journal",
  email: "Email Draft", study: "Study Guide", expand: "Expand Section", tldr: "TL;DR"
};

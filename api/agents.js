// Vercel Serverless Function: GET /api/agents
// Fetches agents from Notion Agent OS database

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const DATABASE_ID = "852b72a2-9ae3-4f8c-ade5-c03afde0aa24"; // Agents database

const COLORS = {
  "AGT-1": "#6366F1",
  "AGT-2": "#EC4899",
  "AGT-3": "#F97316",
  "AGT-4": "#10B981",
  "AGT-5": "#1E3A5F",
};
const DEFAULT_COLOR = "#6B7280";

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // 1. Query Notion database for all agents
    const dbResponse = await fetch(
      `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NOTION_API_KEY}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sorts: [{ property: "Agent ID", direction: "ascending" }],
        }),
      }
    );

    if (!dbResponse.ok) {
      const err = await dbResponse.text();
      console.error("Notion DB query failed:", err);
      return res.status(500).json({ error: "Failed to query Notion", details: err });
    }

    const dbData = await dbResponse.json();

    // 2. For each agent, fetch page content (blocks) for detailed info
    const agents = await Promise.all(
      dbData.results.map(async (page) => {
        const props = page.properties;

        // Extract properties
        const agentId = props["Agent ID"]?.unique_id
          ? `AGT-${props["Agent ID"].unique_id.number}`
          : props["Agent ID"]?.auto_increment_id?.value || "";
        const name = props["Name"]?.title?.[0]?.plain_text || "";
        const role = props["Role"]?.rich_text?.[0]?.plain_text || "";
        const slug = props["Slug"]?.rich_text?.[0]?.plain_text || "";
        const status = props["Status"]?.select?.name || "Draft";
        const version = props["Version"]?.number || 1;
        const invokeCount = props["Invoke Count"]?.number || 0;
        const lastInvoked = props["Last Invoked"]?.date?.start || null;
        const domains = props["Domain"]?.multi_select?.map((d) => d.name) || [];
        const tags = props["Tags"]?.multi_select?.map((t) => t.name) || [];
        const platform = props["Platform"]?.multi_select?.map((p) => p.name) || [];

        // Fetch page blocks for content
        let content = {};
        try {
          const blocksRes = await fetch(
            `https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`,
            {
              headers: {
                Authorization: `Bearer ${NOTION_API_KEY}`,
                "Notion-Version": "2022-06-28",
              },
            }
          );
          if (blocksRes.ok) {
            const blocksData = await blocksRes.json();
            content = parseBlocks(blocksData.results, name);
          }
        } catch (e) {
          console.error(`Failed to fetch blocks for ${name}:`, e);
        }

        // Get icon from page
        const icon = page.icon?.emoji || "🤖";

        return {
          id: agentId,
          name,
          icon,
          role,
          tagline: role,
          status,
          version,
          platform,
          domains,
          tags,
          invokeCount,
          lastInvoked: lastInvoked ? formatDate(lastInvoked) : null,
          slug,
          color: COLORS[agentId] || DEFAULT_COLOR,
          ...content,
        };
      })
    );

    // Cache for 5 minutes
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({ agents, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: "Internal server error", message: error.message });
  }
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  const months = ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function parseBlocks(blocks, agentName) {
  let currentSection = "";
  const sections = {};
  let allText = [];

  for (const block of blocks) {
    if (block.type === "heading_2") {
      currentSection = getPlainText(block.heading_2.rich_text).toUpperCase().trim();
    } else if (block.type === "paragraph") {
      const text = getPlainText(block.paragraph.rich_text);
      if (text && currentSection) {
        if (!sections[currentSection]) sections[currentSection] = [];
        sections[currentSection].push(text);
      }
      if (text) allText.push(text);
    } else if (block.type === "bulleted_list_item") {
      const text = getPlainText(block.bulleted_list_item.rich_text);
      if (text && currentSection) {
        if (!sections[currentSection]) sections[currentSection] = [];
        sections[currentSection].push(text);
      }
    } else if (block.type === "numbered_list_item") {
      const text = getPlainText(block.numbered_list_item.rich_text);
      if (text && currentSection) {
        if (!sections[currentSection]) sections[currentSection] = [];
        sections[currentSection].push(text);
      }
    }
  }

  // Extract structured data from sections
  const mission = extractSection(sections, ["CHI SEI"]);
  const style = extractSection(sections, ["COME COMUNICHI"]);
  const expertiseRaw = extractSection(sections, ["IL TUO DOMINIO"]);
  const guardrailsRaw = extractSection(sections, ["GUARDRAILS"]);
  const outputsRaw = extractSection(sections, ["FORMATI DI OUTPUT"]);

  // Parse expertise as array
  const expertise = expertiseRaw
    ? expertiseRaw
        .split("\n")
        .filter((l) => l.match(/^\d+\.\s|^-\s|^\*\s/) || l.includes(" — "))
        .map((l) => l.replace(/^\d+\.\s*|^-\s*|^\*\s*/, "").trim())
        .filter((l) => l.length > 10)
    : [];

  // Parse guardrails as array
  const guardrails = guardrailsRaw
    ? guardrailsRaw
        .split("\n")
        .filter((l) => l.startsWith("MAI") || l.startsWith("SEMPRE"))
        .map((l) => l.replace(/^-\s*|^\*\s*/, "").trim())
    : [];

  // Parse outputs as array of names
  const outputs = outputsRaw
    ? outputsRaw
        .split("\n")
        .filter((l) => l.includes(":**") || l.includes(":"))
        .map((l) => {
          const match = l.match(/\*\*(.+?)\*\*|^-\s*\*?(.+?):/);
          return match ? (match[1] || match[2] || "").trim() : "";
        })
        .filter((l) => l.length > 0 && l.length < 40)
    : [];

  // Extract personality from CHI SEI
  const personalityMatch = mission ? mission.match(/Il tuo stile[^.]*\.|Non sei[^.]*\.|Sei[^.]*\./) : null;
  const personality = personalityMatch ? personalityMatch[0] : mission ? mission.split(".").slice(0, 2).join(".") + "." : "";

  // Extract quote from FORMATI DI OUTPUT (usually the "Regola:" at the end)
  const quoteMatch = allText.find((t) => t.startsWith("Regola:") || t.startsWith("Regola d'oro:"));
  const quote = quoteMatch ? quoteMatch.replace(/^Regola[^:]*:\s*/, "") : "";

  return {
    personality: personality || `${agentName} è un agente AI specializzato.`,
    mission: mission ? mission.split(".").slice(0, 3).join(".") + "." : "",
    style: style ? style.split(".").slice(0, 3).join(".") + "." : "",
    context: "",
    expertise: expertise.length > 0 ? expertise : [`Esperto nel dominio di ${agentName}`],
    outputs: outputs.length > 0 ? outputs : ["Report", "Analisi"],
    guardrails: guardrails.length > 0 ? guardrails : [],
    quote: quote || "L'output deve essere sempre azionabile.",
  };
}

function extractSection(sections, keys) {
  for (const key of keys) {
    if (sections[key]) return sections[key].join("\n");
  }
  return "";
}

function getPlainText(richTextArray) {
  if (!richTextArray || richTextArray.length === 0) return "";
  return richTextArray.map((t) => t.plain_text).join("");
}

import type { APIRoute } from "astro";
import { getCollection } from "astro:content";

function stripFrontmatter(raw: string): string {
  const match = raw.match(/^---\s*\n[\s\S]*?\n---\s*\n/);
  return match ? raw.slice(match[0].length).trim() : raw.trim();
}

function stripHeroImage(content: string): string {
  // Remove the hero image line (first ![...](...) at the start)
  return content.replace(/^!\[.*?\]\(.*?\)\s*\n*/m, "");
}

export const GET: APIRoute = async () => {
  const posts = await getCollection("blog", ({ data }) => !data.draft);
  const sorted = posts.sort(
    (a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime()
  );

  const sections: string[] = [
    "# Murat Karslioglu - Blog (Full Content)",
    "",
    `> All blog posts from muratkarslioglu.com. ${sorted.length} posts, generated ${new Date().toISOString().split("T")[0]}.`,
    "",
  ];

  for (const post of sorted) {
    const url = `https://muratkarslioglu.com/blog/${post.id}/`;
    const date = new Date(post.data.date).toISOString().split("T")[0];
    const tags = post.data.tags?.length ? post.data.tags.join(", ") : "";

    sections.push("---");
    sections.push("");
    sections.push(`## ${post.data.title}`);
    sections.push("");
    sections.push(`URL: ${url}`);
    sections.push(`Date: ${date}`);
    if (tags) sections.push(`Tags: ${tags}`);
    sections.push("");

    // Read the raw markdown source
    const body = (post as any).body;
    if (body) {
      const content = stripHeroImage(stripFrontmatter(body));
      sections.push(content);
    } else {
      sections.push(post.data.description);
    }

    sections.push("");
  }

  return new Response(sections.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};

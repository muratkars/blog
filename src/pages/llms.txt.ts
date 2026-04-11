import type { APIRoute } from "astro";
import { getCollection } from "astro:content";

export const GET: APIRoute = async () => {
  const posts = await getCollection("blog", ({ data }) => !data.draft);
  const sorted = posts.sort(
    (a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime()
  );

  const lines: string[] = [
    "# Murat Karslioglu",
    "",
    "> Personal blog covering storage infrastructure, distributed systems, NVMe, erasure coding, and systems programming. Written by Murat Karslioglu, a storage engineer building infrastructure for GPU compute and AI workloads.",
    "",
    "## About",
    "",
    "Murat is a storage infrastructure engineer, author of two Kubernetes books (Packt), patent holder for modular storage interfaces, and founder of three startups. He writes deep-dive technical posts on storage systems, hardware trends, and systems programming with a focus on Rust, NVMe, and data durability.",
    "",
    "## Blog Posts",
    "",
  ];

  for (const post of sorted) {
    const url = `https://muratkarslioglu.com/blog/${post.id}/`;
    const tags = post.data.tags?.length ? ` [${post.data.tags.join(", ")}]` : "";
    lines.push(`- [${post.data.title}](${url})${tags}`);
    lines.push(`  ${post.data.description}`);
  }

  lines.push("");
  lines.push("## Full Content");
  lines.push("");
  lines.push(
    "For the complete text of all posts in a single file, see [llms-full.txt](https://muratkarslioglu.com/llms-full.txt)"
  );
  lines.push("");

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};

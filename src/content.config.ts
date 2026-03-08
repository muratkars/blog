import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    description: z.string(),
    tags: z.array(z.string()).default([]),
    type: z.enum(["standard", "story"]).default("standard"),
    featured: z.boolean().default(false),
    image: z.string().optional(),
    readTime: z.string().optional(),
    draft: z.boolean().default(false),
    lastUpdated: z.coerce.date().optional(),
    // Magazine-specific metadata (optional, used only in /magazine view)
    magazineSubtitle: z.string().optional(),
    magazineImage: z.string().optional(),
    magazineCategory: z.string().optional(),
    magazineExcerpt: z.string().optional(),
    magazineOrder: z.number().optional(),
  }),
});

export const collections = { blog };

import { defineConfig } from "blume";
import { orama } from "blume/search";
import { filesystem, githubReleases } from "blume/sources";

export default defineConfig({
  title: "supercarto",
  description:
    "Documentation for supercarto — token-budgeted map context for AI agents: one call returns a walkable topological graph of any coordinate, with weather, terrain, daylight, indoor floors and GTFS transit built in.",

  theme: {
    accent: "teal",
    mode: "system",
  },

  content: {
    root: "docs",
    sources: [
      filesystem({ root: "docs" }),
      githubReleases({
        prefix: "changelog",
        owner: "Unselfisheologism",
        repo: "supercarto",
      }),
    ],
  },

  changelog: {
    title: "Release notes",
    description: "Every supercarto release, newest first, sourced from GitHub Releases.",
  },

  search: orama(),

  github: {
    owner: "Unselfisheologism",
    repo: "supercarto",
    branch: "master",
    dir: "site-docs",
  },

  lastModified: "git",

  agents: {
    llmsTxt: true,
    catalog: true,
    skillMd: true,
    mcp: { enabled: false },
  },

  seo: {
    og: { enabled: true },
    rss: { enabled: true, types: ["blog", "changelog"] },
    sitemap: true,
    robots: true,
    structuredData: true,
  },

  markdown: {
    code: { icons: true },
  },

  toc: { minHeadingLevel: 2, maxHeadingLevel: 3 },

  deployment: {
    site: "https://supercarto.pages.dev",
    base: "/docs",
  },
});

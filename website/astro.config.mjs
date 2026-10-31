import starlight from "@astrojs/starlight";
import { defineConfig, passthroughImageService } from "astro/config";

// One surface for every code frame — the block, its tab bar and a terminal's title bar — a step
// off the page ground in each theme.
const surface = ({ theme }) => (theme.type === "dark" ? "#181a21" : "#f1f2f5");

export default defineConfig({
  integrations: [
    starlight({
      title: "Chernabog",
      description:
        "Spend spare coding-agent capacity on queued work across your repos, with durable flows committed to each repo.",
      logo: {
        light: "./src/assets/mark-light.svg",
        dark: "./src/assets/mark-dark.svg",
        alt: "",
      },
      customCss: [
        "@fontsource-variable/atkinson-hyperlegible-next",
        "@fontsource-variable/atkinson-hyperlegible-mono",
        "./src/styles/theme.css",
      ],
      // Code blocks match the theme: the frame loses its shadow and takes the same hairline and
      // radius as everything else.
      expressiveCode: {
        themes: ["vitesse-dark", "vitesse-light"],
        styleOverrides: {
          borderRadius: "0.25rem",
          borderColor: "var(--sl-color-hairline)",
          codeFontFamily: "var(--__sl-font-mono)",
          uiFontFamily: "var(--__sl-font)",
          codeBackground: surface,
          frames: {
            shadowColor: "transparent",
            editorTabBarBackground: surface,
            editorActiveTabBackground: surface,
            editorActiveTabIndicatorTopColor: "transparent",
            editorActiveTabIndicatorBottomColor: "var(--sl-color-accent)",
            editorTabBarBorderBottomColor: "var(--sl-color-hairline)",
            terminalBackground: surface,
            terminalTitlebarBackground: surface,
            terminalTitlebarBorderBottomColor: "var(--sl-color-hairline)",
            terminalTitlebarDotsOpacity: "0.3",
          },
        },
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/dataquail/chernabog",
        },
      ],
      editLink: { baseUrl: "https://github.com/dataquail/chernabog/edit/main/website/" },
      sidebar: [
        {
          label: "Start",
          items: [
            { slug: "start/introduction" },
            { slug: "start/installation" },
            { slug: "start/set-up-a-repo" },
          ],
        },
        {
          label: "Work",
          items: [{ slug: "work/flows" }, { slug: "work/live-view" }, { slug: "work/commands" }],
        },
        {
          label: "Recipes",
          items: [
            { slug: "recipes" },
            { slug: "recipes/implement" },
            { slug: "recipes/review" },
            { slug: "recipes/re-review" },
            { slug: "recipes/address-review" },
            { slug: "recipes/resolve-conflicts" },
            { slug: "recipes/plan" },
            { slug: "recipes/epic" },
            { slug: "recipes/human-initiated" },
            { slug: "recipes/post-merge" },
            { slug: "recipes/packages" },
          ],
        },
        {
          label: "Agents",
          items: [
            { slug: "agents/adapters" },
            { slug: "agents/launchers" },
            { slug: "agents/usage-gate" },
          ],
        },
        {
          label: "Operate",
          items: [
            { slug: "operate/daemon" },
            { slug: "operate/trust" },
            { slug: "operate/versions" },
          ],
        },
        {
          label: "Write flows",
          items: [
            { slug: "flows/flows" },
            { slug: "flows/composing" },
            { slug: "flows/steps" },
            { slug: "flows/rehearsing" },
            { slug: "flows/sdk" },
          ],
        },
        {
          label: "Reference",
          items: [{ slug: "reference/configuration" }],
        },
      ],
    }),
  ],
  // The site's only images are SVG, which need no optimizing, so no Sharp.
  image: { service: passthroughImageService() },
  site: "https://dataquail.github.io",
  base: "/chernabog",
});

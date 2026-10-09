// The site of the systems program: the thesis, the labs and the results. GitHub Pages serves it at /systems/.
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const base = process.env.SITE_BASE ?? "/systems";

export default defineConfig({
  site: "https://mark1russell7.github.io",
  base,
  trailingSlash: "ignore",
  integrations: [
    starlight({
      title: "systems",
      description: "How long until a client knows that its peer is gone, computed and then measured.",
      logo: { src: "./src/assets/mark.svg", replacesTitle: false },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/mark1russell7/systems" }],
      editLink: { baseUrl: "https://github.com/mark1russell7/systems/edit/main/packages/site/" },
      customCss: [
        "@fontsource-variable/atkinson-hyperlegible-next",
        "@fontsource-variable/atkinson-hyperlegible-mono",
        "./src/styles/tokens.css",
        "./src/styles/theme.css",
      ],
      sidebar: [
        { label: "Thesis", items: ["thesis"] },
        { label: "Lab", items: ["lab/detection"] },
        { label: "Results", items: ["results/harness"] },
        { label: "About", items: ["about"] },
      ],
    }),
    react(),
  ],
});

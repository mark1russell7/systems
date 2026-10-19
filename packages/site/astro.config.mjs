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
      // IBM Plex Sans and IBM Plex Mono: the files of Google Fonts, from Fontsource, served by the site itself
      customCss: [
        "@fontsource-variable/ibm-plex-sans",
        "@fontsource/ibm-plex-mono/400.css",
        "@fontsource/ibm-plex-mono/500.css",
        "@fontsource/ibm-plex-mono/600.css",
        "./src/styles/tokens.css",
        "./src/styles/theme.css",
        "./src/styles/kit.css",
        "./src/styles/home.css",
      ],
      components: {
        Hero: "./src/components/Hero.astro",
        PageTitle: "./src/components/PageTitle.astro",
      },
      sidebar: [
        { label: "Thesis", items: ["thesis"] },
        { label: "Lab", items: ["lab/detection"] },
        {
          label: "Results",
          items: [
            "results/calibration",
            "results/cells",
            "results/faults",
            "results/topologies",
            "results/sentinel",
            "results/http",
            "results/mongodb",
            "results/pg",
            "results/rabbitmq",
            "results/grpc",
            "results/kind",
            "results/r3",
            "results/timers",
            "results/harness",
          ],
        },
        { label: "About", items: ["about"] },
      ],
    }),
    react(),
  ],
});

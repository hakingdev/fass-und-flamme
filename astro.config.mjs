import { defineConfig } from "astro/config";
import vercel from "@astrojs/vercel";

export default defineConfig({
  adapter: vercel(),
  output: "server",
  site: "https://www.fassflamme.de",
});

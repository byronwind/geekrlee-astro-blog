import { defineAstroPaperConfig } from "./src/types/config";

export default defineAstroPaperConfig({
  site: {
    url: "https://geekrlee-blog.pages.dev/",
    title: "GEEKR.Lee",
    description: "Thinking & Walking & Writing about Technology & Life",
    author: "Lee",
    profile: "https://geekrlee-blog.pages.dev/",
    ogImage: "geekr.png",
    lang: "en",
    timezone: "Asia/Shanghai",
    dir: "ltr",
  },
  posts: {
    perIndex: 6,
    perPage: 6,
    scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
  },
  features: {
    lightAndDarkMode: true,
    dynamicOgImage: true,
    showArchives: true,
    showBackButton: true,
    editPost: { enabled: false },
    search: "pagefind",
  },
  socials: [
    { name: "github", url: "https://github.com/byronwind" },
    { name: "x", url: "https://x.com/ligqli" },
    // { name: "linkedin", url: "https://www.linkedin.com/in/username/" },
    // { name: "mail", url: "mailto:yourmail@gmail.com" },
  ],
  shareLinks: [
    { name: "whatsapp", url: "https://wa.me/?text=" },
    { name: "facebook", url: "https://www.facebook.com/sharer.php?u=" },
    { name: "x", url: "https://x.com/intent/post?url=" },
    { name: "telegram", url: "https://t.me/share/url?url=" },
    // { name: "pinterest", url: "https://pinterest.com/pin/create/button/?url=" },
    { name: "mail", url: "mailto:?subject=See%20this%20post&body=" },
  ],
});

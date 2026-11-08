/**
 * One-click ideas fill the composer; the user finishes the sentence before sending.
 * Keep them plain, from-scratch video jobs: the Motion agent plans and designs the video itself.
 * Each hint is one everyday line on what the job is for. Every chip is a job with its own
 * job skill, which loads from the typed request, so a chip never names a skill.
 */
export const MOTION_STARTERS = [
  {
    label: "Make a product launch",
    prompt: "Make a product launch video for: ",
    hint: "Announce something new and make people want it",
  },
  {
    label: "Make an app walkthrough",
    prompt: "Make an app walkthrough video for: ",
    hint: "Show how your app is used, from your screenshots",
  },
  {
    label: "Make a website video",
    prompt: "Make a video about my website: ",
    hint: "A video made from your real site, to bring people to it",
  },
  {
    label: "Make a before and after",
    prompt: "Make a before-and-after video for: ",
    hint: "Life without your product, then with it",
  },
  {
    label: "Make a developer tool video",
    prompt: "Make a video about my developer tool: ",
    hint: "Your tool's real commands and output, shown running",
  },
  {
    label: "Make one like my example",
    prompt: "Make a video like my attached example, about: ",
    hint: "The feel of a video you like, about your own subject",
  },
] as const;

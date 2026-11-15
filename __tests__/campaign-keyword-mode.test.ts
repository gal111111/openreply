import { describe, expect, it } from "vitest";
import {
  buildAutomationCreateFields,
  createAutomationSchema,
} from "../lib/campaigns/automation-input";
import { matchKeywords } from "../lib/utils/keyword-matcher";

const campaignInput = {
  name: "人才登記",
  matchAnyPost: true,
  dmTriggerEnabled: true,
  keywords: ["登記", "时薪"],
  dmMessage: "請填寫人才登記表。",
};

const talentKeywords = [
  "登記", "登记", "報名", "报名", "應徵", "应征",
  "想做", "有興趣", "有兴趣", "register", "搵工", "揾工",
];

describe("campaign keyword matching mode", () => {
  it("keeps the original ten keywords when adding both Talent CTA spellings", () => {
    const input = createAutomationSchema.parse({
      ...campaignInput,
      keywords: talentKeywords,
      wholeWordMatch: false,
    });
    const campaign = buildAutomationCreateFields(input);

    expect(campaign.keywords).toEqual(talentKeywords);
    for (const keyword of talentKeywords) {
      expect(matchKeywords(`我想${keyword}，請傳連結`, campaign.keywords, false).matched)
        .toBe(true);
    }
  });

  it("rejects a thirteenth keyword and keeps the per-keyword length bound", () => {
    expect(createAutomationSchema.safeParse({
      ...campaignInput,
      keywords: [...talentKeywords, "extra"],
    }).success).toBe(false);
    expect(createAutomationSchema.safeParse({
      ...campaignInput,
      keywords: ["x".repeat(51)],
    }).success).toBe(false);
  });

  it("preserves partial matching from campaign input through Chinese keyword matching", () => {
    const input = createAutomationSchema.parse({
      ...campaignInput,
      wholeWordMatch: false,
    });
    const campaign = buildAutomationCreateFields(input);

    expect(campaign.wholeWordMatch).toBe(false);
    for (const message of ["我想登記活動助理", "请问时薪是多少"]) {
      expect(
        matchKeywords(message, campaign.keywords, campaign.wholeWordMatch).matched
      ).toBe(true);
    }
  });

  it("retains the existing whole-word default when the setting is omitted", () => {
    const campaign = buildAutomationCreateFields(
      createAutomationSchema.parse(campaignInput)
    );

    expect(campaign.wholeWordMatch).toBe(true);
    expect(matchKeywords("登記", campaign.keywords, campaign.wholeWordMatch).matched)
      .toBe(true);
    expect(
      matchKeywords("我想登記活動助理", campaign.keywords, campaign.wholeWordMatch).matched
    ).toBe(false);
  });
});

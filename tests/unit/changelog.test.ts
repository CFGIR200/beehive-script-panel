/**
 * changelogBlock — Persian release-changelog renderer for bot messages
 * (UPDRELEASE-1). The wording rules (heading variants, HTML escaping, bullet
 * rendering) drive four different bot surfaces: the cron update notice, the
 * per-panel update confirmation, both bulk-update confirmations and the
 * update-completion message, so they are pinned here.
 */

import { describe, expect, it } from "vitest";
import { changelogBlock } from "../../src/bot/messages";

describe("changelogBlock", () => {
  const text = "خط اول\nخط دوم\n\n  \nخط سوم";

  it("renders one bullet per non-empty line under the target-version heading", () => {
    const block = changelogBlock({ to: "3.1.14", changelogFa: text });
    expect(block).toContain("تغییرات نسخهٔ <code>3.1.14</code>:");
    expect(block).toContain("• خط اول\n• خط دوم\n• خط سوم");
    // Blank and whitespace-only lines collapse away.
    expect(block).not.toContain("•  ");
  });

  it("names the installed version when it differs from the target", () => {
    const block = changelogBlock({ to: "3.1.14", from: "3.1.13", changelogFa: "خط اول" });
    expect(block).toContain("تغییرات نسخهٔ <code>3.1.14</code> نسبت به نسخهٔ <code>3.1.13</code>");
  });

  it("uses the stale-build heading when the installed version equals the target", () => {
    const block = changelogBlock({ to: "3.1.14", from: "3.1.14", changelogFa: "خط اول" });
    expect(block).toContain("تغییرات این بیلد نسبت به بیلد نصب‌شدهٔ فعلی");
    expect(block).not.toContain("<code>");
  });

  it("returns an empty string when there is no changelog", () => {
    expect(changelogBlock({ to: "3.1.14" })).toBe("");
    expect(changelogBlock({ to: "3.1.14", changelogFa: null })).toBe("");
    expect(changelogBlock({ to: "3.1.14", changelogFa: "" })).toBe("");
    expect(changelogBlock({ to: "3.1.14", changelogFa: "  \n\t " })).toBe("");
  });

  it("escapes HTML specials inside changelog lines", () => {
    const block = changelogBlock({ to: "3.1.14", changelogFa: "<b>bold</b> & <i>ital</i>" });
    expect(block).toContain("• &lt;b&gt;bold&lt;/b&gt; &amp; &lt;i&gt;ital&lt;/i&gt;");
    expect(block).not.toContain("<b>bold</b>");
  });
});

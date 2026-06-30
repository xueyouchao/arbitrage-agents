import { describe, expect, it } from "vitest";
import { resolveWorldCupTeam, WORLDCUP_TEAM_CODES } from "../src/contexts/worldcup/domain/worldcup-teams";

describe("World Cup team alias resolution", () => {
  it("resolves canonical team codes", () => {
    expect(resolveWorldCupTeam("bra")).toBe("bra");
    expect(resolveWorldCupTeam("arg")).toBe("arg");
    expect(resolveWorldCupTeam("usa")).toBe("usa");
  });

  it("resolves common aliases", () => {
    expect(resolveWorldCupTeam("brazil")).toBe("bra");
    expect(resolveWorldCupTeam("argentina")).toBe("arg");
    expect(resolveWorldCupTeam("united states")).toBe("usa");
    expect(resolveWorldCupTeam("south korea")).toBe("kor");
    expect(resolveWorldCupTeam("netherlands")).toBe("ned");
  });

  it("resolves nicknames", () => {
    expect(resolveWorldCupTeam("canarinho")).toBe("bra");
    expect(resolveWorldCupTeam("les bleus")).toBe("fra");
    expect(resolveWorldCupTeam("super eagles")).toBe("nga");
    expect(resolveWorldCupTeam("albirroja")).toBe("par");
    expect(resolveWorldCupTeam("orange")).toBeUndefined(); // "oranje" yes, "orange" no
    expect(resolveWorldCupTeam("oranje")).toBe("ned");
  });

  it("returns undefined for unknown team names", () => {
    expect(resolveWorldCupTeam("nowhereistan")).toBeUndefined();
    expect(resolveWorldCupTeam("atlantis")).toBeUndefined();
  });

  it("returns undefined for empty strings", () => {
    expect(resolveWorldCupTeam("")).toBeUndefined();
    expect(resolveWorldCupTeam("   ")).toBeUndefined();
  });

  it("has all expected FIFA 2026 qualified teams", () => {
    // At minimum, we need these four host/qualified teams.
    expect(WORLDCUP_TEAM_CODES.has("bra")).toBe(true);
    expect(WORLDCUP_TEAM_CODES.has("arg")).toBe(true);
    expect(WORLDCUP_TEAM_CODES.has("usa")).toBe(true);
    expect(WORLDCUP_TEAM_CODES.has("can")).toBe(true);
    expect(WORLDCUP_TEAM_CODES.has("mex")).toBe(true);
    expect(WORLDCUP_TEAM_CODES.has("fra")).toBe(true);
    expect(WORLDCUP_TEAM_CODES.has("eng")).toBe(true);
  });
});

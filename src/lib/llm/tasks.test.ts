import { describe, expect, it } from "vitest";
import { specialtyByAge } from "./tasks";

const SPECIALTIES = ["General Medicine", "Pediatrics"];

describe("specialty by age (rule, not a model guess)", () => {
  it("sends adults to General Medicine, never Pediatrics", () => {
    expect(specialtyByAge("feeling dizzy since morning", 45, SPECIALTIES)).toBe("General Medicine");
    expect(specialtyByAge("Amir, 45 years, chest pain", null, SPECIALTIES)).toBe("General Medicine");
  });

  it("sends children to Pediatrics", () => {
    expect(specialtyByAge("ear ache since last night", 4, SPECIALTIES)).toBe("Pediatrics");
    expect(specialtyByAge("my son has a fever", null, SPECIALTIES)).toBe("Pediatrics");
    expect(specialtyByAge("6 yo with a rash", null, SPECIALTIES)).toBe("Pediatrics");
  });

  it("leaves it to the models when there is no age signal", () => {
    expect(specialtyByAge("repeat prescription for an inhaler", null, SPECIALTIES)).toBeNull();
  });
});

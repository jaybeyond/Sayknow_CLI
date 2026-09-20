import { expect, test } from "bun:test";
import {
	formatModelOnboardingGuidance,
	formatModelOnboardingInlineHint,
	MODEL_ONBOARDING_TYPESAFE_COMMAND,
} from "../src/setup/model-onboarding-guidance";

// TypeSafe is not a chat model, so it can never appear in the model list itself. The
// only way a user discovers it is from the credential-adding surfaces — and the first
// attempt put it solely under `/provider`, which is not where people go to add a key.
test("the model onboarding surfaces name the TypeSafe entry point", () => {
	expect(MODEL_ONBOARDING_TYPESAFE_COMMAND).toBe("/provider typesafe");
	// /model renders the inline hint, so it has to carry the command.
	expect(formatModelOnboardingInlineHint()).toContain(MODEL_ONBOARDING_TYPESAFE_COMMAND);
	expect(formatModelOnboardingGuidance()).toContain(MODEL_ONBOARDING_TYPESAFE_COMMAND);
});

test("the guidance says plainly that TypeSafe is not a chat model", () => {
	// Without this, the entry reads like a model you could select and assign to a role.
	expect(formatModelOnboardingGuidance()).toContain("not a chat model");
});

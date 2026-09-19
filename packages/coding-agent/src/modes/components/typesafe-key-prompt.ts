/**
 * Key entry for TypeSafe, reachable from the same place models are added.
 *
 * TypeSafe is not a chat model, so it never appears in the model picker — but the place
 * users look when they want to "add a model with a key" is this onboarding list, and
 * making them find a CLI subcommand instead would mean most users never enable it.
 *
 * The key is taken through {@link SecretInput} and consumed once: it is never rendered,
 * never placed in a flag, and never written anywhere but the credential store.
 */
import { Container, type Input, matchesKey, SecretInput, Spacer, Text, TruncatedText } from "@sayknow-cli/tui";
import { theme } from "../theme/theme";
import { matchesSelectCancel } from "../utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";

export interface TypeSafeKeyPromptResult {
	apiKey: string;
}

export class TypeSafeKeyPromptComponent extends Container {
	#content: Container;
	#input: SecretInput | null = null;
	#onSubmit: (result: TypeSafeKeyPromptResult) => void;
	#onCancel: () => void;
	#onRender: () => void;
	#busy = false;
	#error: string | null = null;

	constructor(
		onSubmit: (result: TypeSafeKeyPromptResult) => void,
		onCancel: () => void,
		onRender: () => void = () => {},
	) {
		super();
		this.#onSubmit = onSubmit;
		this.#onCancel = onCancel;
		this.#onRender = onRender;
		this.#content = new Container();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold("TypeSafe (typed decisions)")));
		this.addChild(
			new TruncatedText(
				theme.fg(
					"muted",
					"  Routes workflow decisions through the hosted System One model instead of your chat model.",
				),
				0,
				0,
			),
		);
		this.addChild(
			new TruncatedText(theme.fg("muted", "  Without a key this stays off and nothing else changes."), 0, 0),
		);
		this.addChild(new Spacer(1));
		this.addChild(this.#content);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.#render();
	}

	/** Shown while the key is being checked against the live API. */
	setBusy(busy: boolean): void {
		this.#busy = busy;
		this.#render();
	}

	/** Keeps the prompt open so a rejected key can be corrected without restarting. */
	setError(message: string): void {
		this.#busy = false;
		this.#error = message;
		this.#render();
	}

	#render(): void {
		this.#content.clear();
		if (this.#busy) {
			this.#input = null;
			this.#content.addChild(new Text(theme.fg("muted", "Verifying key against TypeSafe…"), 0, 0));
			this.#onRender();
			return;
		}
		if (this.#error) {
			this.#content.addChild(new Text(theme.fg("error", this.#error), 0, 0));
			this.#content.addChild(new Spacer(1));
		}
		this.#content.addChild(new Text("Paste your TypeSafe API key:", 0, 0));
		this.#content.addChild(new Spacer(1));
		const input = new SecretInput();
		input.onSubmit = secret => {
			const apiKey = secret.consume().trim();
			if (!apiKey) return;
			this.#error = null;
			this.#onSubmit({ apiKey });
		};
		this.#input = input;
		this.#content.addChild(input);
		this.#onRender();
	}

	handleInput(keyData: string): void {
		if (matchesSelectCancel(keyData) || matchesKey(keyData, "escape")) {
			this.#onCancel();
			return;
		}
		(this.#input as Input | SecretInput | null)?.handleInput(keyData);
	}
}

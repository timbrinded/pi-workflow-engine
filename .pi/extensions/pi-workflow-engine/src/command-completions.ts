import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";

interface ArgumentCompletionCandidate {
  readonly value: string;
  readonly description?: string;
}

interface ArgumentPrefixParts {
  readonly completed: readonly string[];
  readonly current: string;
  readonly base: string;
}

/** Split a slash-command argument prefix while retaining the text Pi will replace. */
export function splitArgumentPrefix(argumentPrefix: string): ArgumentPrefixParts {
  const match = /(\S*)$/.exec(argumentPrefix);
  const current = match?.[1] ?? "";
  const base = argumentPrefix.slice(0, argumentPrefix.length - current.length);
  const completed = base.trim().split(/\s+/).filter(Boolean);
  return { completed, current, base };
}

/** Complete the current argument and return full replacement values, as Pi expects. */
export function completeCurrentArgument(
  argumentPrefix: string,
  candidates: readonly ArgumentCompletionCandidate[],
): AutocompleteItem[] | null {
  const { current, base } = splitArgumentPrefix(argumentPrefix);
  const matches = fuzzyFilter([...candidates], current, (candidate) => candidate.value)
    .map((candidate) => ({
      value: `${base}${candidate.value}`,
      label: candidate.value,
      ...(candidate.description === undefined ? {} : { description: candidate.description }),
    }));
  return matches.length > 0 ? matches : null;
}

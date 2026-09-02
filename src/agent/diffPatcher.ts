export interface DiffBlock {
  path: string;
  search: string;
  replace: string;
}

export interface DiffResult {
  path: string;
  success: boolean;
  content?: string;
  error?: string;
  fuzzyMatched?: boolean;
}

export function parseSearchReplaceBlocks(raw: string): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  const regex = /<<<<<<< SEARCH\s*\n([\s\S]*?)\n=======\s*\n([\s\S]*?)\n>>>>>>> REPLACE/g;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    const header = raw.slice(Math.max(0, match.index - 200), match.index);
    const pathMatch = header.match(/(?:file|path)[:=]\s*"?([^\s"\n]+)"?/i);
    blocks.push({
      path: pathMatch ? pathMatch[1] : '',
      search: match[1],
      replace: match[2],
    });
  }
  return blocks;
}

export function applyDiff(currentContent: string, block: DiffBlock): DiffResult {
  const exactIdx = currentContent.indexOf(block.search);
  if (exactIdx !== -1) {
    return {
      path: block.path,
      success: true,
      content: currentContent.slice(0, exactIdx) + block.replace + currentContent.slice(exactIdx + block.search.length),
    };
  }

  const fuzzyIdx = fuzzyLineMatch(currentContent, block.search);
  if (fuzzyIdx !== -1) {
    const searchLines = block.search.split('\n');
    const lines = currentContent.split('\n');
    const patched = lines.slice(0, fuzzyIdx).concat(block.replace.split('\n')).concat(lines.slice(fuzzyIdx + searchLines.length));
    return {
      path: block.path,
      success: true,
      content: patched.join('\n'),
      fuzzyMatched: true,
    };
  }

  return {
    path: block.path,
    success: false,
    error: `SEARCH block not found in ${block.path}. The content may have changed since the last read.`,
  };
}

export function applyAllDiffs(
  workspace: Map<string, string>,
  blocks: DiffBlock[]
): { results: DiffResult[]; allSucceeded: boolean } {
  const results: DiffResult[] = [];
  let allSucceeded = true;

  for (const block of blocks) {
    if (!block.path) {
      results.push({ path: '(unknown)', success: false, error: 'No file path specified in diff block' });
      allSucceeded = false;
      continue;
    }

    const current = workspace.get(block.path);
    if (current === undefined) {
      results.push({ path: block.path, success: false, error: `File not found: ${block.path}` });
      allSucceeded = false;
      continue;
    }

    const result = applyDiff(current, block);
    results.push(result);
    if (result.success && result.content !== undefined) {
      workspace.set(block.path, result.content);
    } else {
      allSucceeded = false;
    }
  }

  return { results, allSucceeded };
}

function fuzzyLineMatch(text: string, search: string): number {
  const textLines = text.split('\n');
  const searchLines = search.split('\n').filter((l) => l.trim().length > 0);
  if (searchLines.length === 0) return -1;

  const maxStart = textLines.length - searchLines.length;
  for (let i = 0; i <= maxStart; i++) {
    let matched = 0;
    for (let j = 0; j < searchLines.length; j++) {
      const textLine = textLines[i + j].trim().replace(/\s+/g, ' ');
      const searchLine = searchLines[j].trim().replace(/\s+/g, ' ');
      if (textLine === searchLine || levenshtein(textLine, searchLine) <= 2) {
        matched++;
      } else {
        break;
      }
    }
    if (matched === searchLines.length) return i;
  }
  return -1;
}

function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

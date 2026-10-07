// LaTeX language support: highlighting (legacy stex mode) and completions.

import { StreamLanguage, HighlightStyle } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { snippetCompletion } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";

export const latexLanguage = StreamLanguage.define(stex);

export const highlightStyle = HighlightStyle.define([
  { tag: [t.tagName, t.macroName], color: "var(--hl-cmd)" },
  { tag: t.keyword, color: "var(--hl-kw)" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "var(--hl-atom)" },
  { tag: t.comment, color: "var(--hl-comment)", fontStyle: "italic" },
  { tag: [t.bracket, t.brace, t.squareBracket], color: "var(--hl-bracket)" },
  { tag: t.number, color: "var(--hl-num)" },
  { tag: [t.string, t.special(t.string)], color: "var(--hl-str)" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "var(--hl-var)" },
  { tag: [t.heading, t.strong], fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.invalid, color: "var(--hl-err)" },
  { tag: t.meta, color: "var(--hl-comment)" },
]);

const TEX_EXT = new Set(["tex", "sty", "cls", "ltx", "dtx", "ins", "def", "tikz", "bbx", "cbx", "clo", "fd", "rnw", "bib"]);
export function isTexFile(name) {
  const ext = String(name).toLowerCase().split(".").pop();
  return TEX_EXT.has(ext);
}

// Plain commands: [name, detail]. "{}" means the command takes a braced argument.
const COMMANDS = [
  ["section{}", "heading"], ["subsection{}", "heading"], ["subsubsection{}", "heading"],
  ["chapter{}", "heading"], ["part{}", "heading"], ["paragraph{}", "heading"],
  ["section*{}", "heading"], ["subsection*{}", "heading"],
  ["textbf{}", "bold"], ["textit{}", "italic"], ["emph{}", "emphasis"], ["underline{}", "underline"],
  ["texttt{}", "monospace"], ["textsc{}", "small caps"], ["textrm{}", ""], ["textsf{}", ""],
  ["label{}", "label"], ["ref{}", "reference"], ["eqref{}", "equation ref"], ["pageref{}", ""],
  ["autoref{}", "hyperref"], ["cref{}", "cleveref"], ["Cref{}", "cleveref"],
  ["cite{}", "citation"], ["citep{}", "natbib"], ["citet{}", "natbib"], ["parencite{}", "biblatex"],
  ["textcite{}", "biblatex"], ["autocite{}", "biblatex"], ["footcite{}", "biblatex"],
  ["footnote{}", ""], ["url{}", ""], ["href{}{}", "hyperref"],
  ["includegraphics{}", "graphicx"], ["input{}", "include file"], ["include{}", "include file"],
  ["usepackage{}", "preamble"], ["documentclass{}", "preamble"], ["newcommand{}{}", "define macro"],
  ["renewcommand{}{}", ""], ["title{}", ""], ["author{}", ""], ["date{}", ""], ["caption{}", ""],
  ["bibliography{}", "bibtex"], ["bibliographystyle{}", "bibtex"], ["addbibresource{}", "biblatex"],
  ["item", "list item"], ["maketitle", ""], ["tableofcontents", ""], ["listoffigures", ""],
  ["listoftables", ""], ["printbibliography", "biblatex"], ["centering", ""], ["noindent", ""],
  ["newpage", ""], ["clearpage", ""], ["today", ""], ["hline", "table rule"], ["toprule", "booktabs"],
  ["midrule", "booktabs"], ["bottomrule", "booktabs"], ["vspace{}", ""], ["hspace{}", ""],
  ["linewidth", "length"], ["textwidth", "length"], ["small", "size"], ["large", "size"],
  ["Large", "size"], ["footnotesize", "size"], ["tiny", "size"], ["huge", "size"],
  ["frac{}{}", "math"], ["sqrt{}", "math"], ["sum", "math"], ["prod", "math"], ["int", "math"],
  ["infty", "math"], ["partial", "math"], ["nabla", "math"], ["cdot", "math"], ["times", "math"],
  ["leq", "math"], ["geq", "math"], ["neq", "math"], ["approx", "math"], ["equiv", "math"],
  ["rightarrow", "math"], ["Rightarrow", "math"], ["leftarrow", "math"], ["mapsto", "math"],
  ["alpha", "greek"], ["beta", "greek"], ["gamma", "greek"], ["delta", "greek"], ["epsilon", "greek"],
  ["varepsilon", "greek"], ["theta", "greek"], ["lambda", "greek"], ["mu", "greek"], ["pi", "greek"],
  ["sigma", "greek"], ["phi", "greek"], ["varphi", "greek"], ["omega", "greek"], ["Omega", "greek"],
  ["Delta", "greek"], ["Gamma", "greek"], ["Sigma", "greek"],
  ["mathbb{}", "math font"], ["mathcal{}", "math font"], ["mathrm{}", "math font"], ["mathbf{}", "math font"],
  ["text{}", "amsmath"], ["left(", "math"], ["right)", "math"], ["quad", "space"], ["qquad", "space"],
  ["hat{}", "accent"], ["bar{}", "accent"], ["vec{}", "accent"], ["tilde{}", "accent"], ["dot{}", "accent"],
  ["overline{}", ""], ["underbrace{}", ""], ["ldots", ""], ["cdots", ""],
];

const ENVIRONMENTS = {
  figure: "\\begin{figure}[htbp]\n\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{${1:file}}\n\t\\caption{${2:Caption}}\n\t\\label{fig:${3:label}}\n\\end{figure}",
  table: "\\begin{table}[htbp]\n\t\\centering\n\t\\begin{tabular}{${1:lll}}\n\t\t${2}\n\t\\end{tabular}\n\t\\caption{${3:Caption}}\n\t\\label{tab:${4:label}}\n\\end{table}",
  tabular: "\\begin{tabular}{${1:ll}}\n\t${2}\n\\end{tabular}",
  itemize: "\\begin{itemize}\n\t\\item ${1}\n\\end{itemize}",
  enumerate: "\\begin{enumerate}\n\t\\item ${1}\n\\end{enumerate}",
  description: "\\begin{description}\n\t\\item[${1:term}] ${2}\n\\end{description}",
  equation: "\\begin{equation}\n\t${1}\n\t\\label{eq:${2:label}}\n\\end{equation}",
  "equation*": "\\begin{equation*}\n\t${1}\n\\end{equation*}",
  align: "\\begin{align}\n\t${1}\n\\end{align}",
  "align*": "\\begin{align*}\n\t${1}\n\\end{align*}",
  gather: "\\begin{gather}\n\t${1}\n\\end{gather}",
  cases: "\\begin{cases}\n\t${1} & ${2}\n\\end{cases}",
  matrix: "\\begin{pmatrix}\n\t${1}\n\\end{pmatrix}",
  frame: "\\begin{frame}{${1:Title}}\n\t${2}\n\\end{frame}",
  abstract: "\\begin{abstract}\n\t${1}\n\\end{abstract}",
  center: "\\begin{center}\n\t${1}\n\\end{center}",
  minipage: "\\begin{minipage}{${1:0.45\\linewidth}}\n\t${2}\n\\end{minipage}",
  verbatim: "\\begin{verbatim}\n${1}\n\\end{verbatim}",
  quote: "\\begin{quote}\n\t${1}\n\\end{quote}",
  theorem: "\\begin{theorem}\n\t${1}\n\\end{theorem}",
  lemma: "\\begin{lemma}\n\t${1}\n\\end{lemma}",
  proof: "\\begin{proof}\n\t${1}\n\\end{proof}",
  definition: "\\begin{definition}\n\t${1}\n\\end{definition}",
  tikzpicture: "\\begin{tikzpicture}\n\t${1}\n\\end{tikzpicture}",
  thebibliography: "\\begin{thebibliography}{9}\n\t\\bibitem{${1:key}} ${2}\n\\end{thebibliography}",
  document: "\\begin{document}\n${1}\n\\end{document}",
};

// Turn "frac{}{}" into a snippet with tab stops: "\\frac{${1}}{${2}}".
function commandSnippet(cmd) {
  let n = 0;
  const body = cmd.replace(/\{\}/g, () => `{\${${++n}}}`);
  return "\\" + body;
}

const commandOptions = COMMANDS.map(([cmd, detail]) => {
  const label = "\\" + cmd.replace(/\{\}/g, "");
  return cmd.includes("{}")
    ? snippetCompletion(commandSnippet(cmd), { label, detail, type: "function" })
    : { label, detail, type: "keyword" };
});

const envOptions = Object.entries(ENVIRONMENTS).map(([name, snip]) =>
  snippetCompletion(snip, { label: `\\begin{${name}}`, detail: "environment", type: "type" }),
);

/**
 * @param {() => Promise<string[]>} getBibKeys  citation keys of the project
 * @param {() => string[]} getLabels  labels of the project
 */
export function latexCompletion(getBibKeys, getLabels) {
  return async (context) => {
    // \cite{key1,ke|
    let m = context.matchBefore(/\\(?:no)?(?:[a-zA-Z]*cite[a-zA-Z]*)\*?(?:\[[^\]]*\])*\{[^}]*/);
    if (m) {
      const braced = m.text.lastIndexOf("{");
      const comma = m.text.lastIndexOf(",");
      const from = m.from + Math.max(braced, comma) + 1;
      const keys = await getBibKeys();
      return { from, options: keys.map((k) => ({ label: k, type: "constant", detail: "citation" })), validFor: /^[^,}\s]*$/ };
    }
    // \ref{lab|
    m = context.matchBefore(/\\(?:[a-zA-Z]*ref|cref|Cref)\{[^}]*/);
    if (m) {
      const from = m.from + m.text.lastIndexOf("{") + 1;
      return { from, options: getLabels().map((l) => ({ label: l, type: "variable", detail: "label" })), validFor: /^[^}\s]*$/ };
    }
    // \begin{fig|
    m = context.matchBefore(/\\begin\{[a-zA-Z*]*/);
    if (m) return { from: m.from, options: envOptions, validFor: /^\\begin\{[a-zA-Z*]*$/ };
    // \comm|
    m = context.matchBefore(/\\[a-zA-Z]*/);
    if (!m || (m.from === m.to && !context.explicit)) return null;
    return { from: m.from, options: [...commandOptions, ...envOptions], validFor: /^\\[a-zA-Z]*$/ };
  };
}

export function extractLabels(text) {
  const out = new Set();
  for (const m of text.matchAll(/\\label\{([^}\s]+)\}/g)) out.add(m[1]);
  return [...out];
}

export function extractBibKeys(text) {
  const out = [];
  for (const m of text.matchAll(/@[a-zA-Z]+\s*[{(]\s*([^,\s]+)\s*,/g)) {
    if (!/^(string|comment|preamble)$/i.test(m[0].slice(1).split(/[{(]/)[0].trim())) out.push(m[1]);
  }
  return out;
}

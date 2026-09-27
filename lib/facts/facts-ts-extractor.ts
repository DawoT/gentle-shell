import ts from "typescript";
import type { FileFacts, SymbolFact, SymbolKind } from "./facts-types.ts";

function getDocstring(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
	const fullText = sourceFile.getFullText();
	const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
	if (!ranges || ranges.length === 0) return undefined;

	for (let i = ranges.length - 1; i >= 0; i--) {
		const range = ranges[i];
		const comment = fullText.slice(range.pos, range.end);
		if (comment.startsWith("/**")) {
			return comment;
		}
	}
	return undefined;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	if (!ts.canHaveModifiers(node)) return false;
	const modifiers = ts.getModifiers(node);
	return modifiers !== undefined && modifiers.some((m) => m.kind === kind);
}

function formatParameters(parameters: ts.NodeArray<ts.ParameterDeclaration>, sourceFile: ts.SourceFile): string {
	return parameters.map((param) => {
		const name = param.name.getText(sourceFile);
		const isOptional = Boolean(param.questionToken || param.initializer);
		const optSign = isOptional && !param.name.getText(sourceFile).includes("?") ? "?" : "";
		const typeStr = param.type ? `: ${param.type.getText(sourceFile)}` : "";
		return `${name}${optSign}${typeStr}`;
	}).join(", ");
}

function formatTypeParameters(typeParams: ts.NodeArray<ts.TypeParameterDeclaration> | undefined, sourceFile: ts.SourceFile): string {
	if (!typeParams || typeParams.length === 0) return "";
	return `<${typeParams.map((p) => p.getText(sourceFile)).join(", ")}>`;
}

/**
 * Deterministically parses TypeScript / JavaScript code and extracts all
 * symbols, type signatures, interfaces, classes, imports, and exports.
 * Never throws on syntax errors (fail-safe).
 */
export function extractTypeScriptFacts(filePath: string, sourceText: string, sha: string): FileFacts {
	const symbols: SymbolFact[] = [];
	const imports: string[] = [];
	const exports: string[] = [];

	let sourceFile: ts.SourceFile;
	try {
		sourceFile = ts.createSourceFile(
			filePath,
			sourceText,
			ts.ScriptTarget.Latest,
			true,
			filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
		);
	} catch {
		// In case of total parser crash, return empty facts
		return { path: filePath, sha, symbols, imports, exports };
	}

	function addSymbol(name: string, kind: SymbolKind, signature: string, node: ts.Node, isExported: boolean, isDefault: boolean = false) {
		const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
		const docstring = getDocstring(node, sourceFile);

		symbols.push({
			name,
			kind,
			signature,
			docstring,
			startLine: start.line + 1,
			endLine: end.line + 1,
			isExported,
		});

		if ((isExported || isDefault) && name && !exports.includes(name)) {
			exports.push(name);
		}
		if (isDefault && !exports.includes("default")) {
			exports.push("default");
		}
	}

	for (const node of sourceFile.statements) {
		const isExported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
		const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);

		if (ts.isFunctionDeclaration(node)) {
			const name = node.name?.getText(sourceFile) || (isDefault ? "default" : "anonymous");
			const isAsync = hasModifier(node, ts.SyntaxKind.AsyncKeyword);
			const typeParams = formatTypeParameters(node.typeParameters, sourceFile);
			const params = formatParameters(node.parameters, sourceFile);
			const returnType = node.type ? `: ${node.type.getText(sourceFile)}` : "";
			const asyncPrefix = isAsync ? "async " : "";
			const signature = `${asyncPrefix}function ${name}${typeParams}(${params})${returnType}`;

			addSymbol(name, "function", signature, node, isExported || isDefault, isDefault);
		} else if (ts.isInterfaceDeclaration(node)) {
			const name = node.name.getText(sourceFile);
			const typeParams = formatTypeParameters(node.typeParameters, sourceFile);
			const members = node.members.map((m) => `  ${m.getText(sourceFile)};`).join("\n");
			const signature = `interface ${name}${typeParams} {\n${members}\n}`;

			addSymbol(name, "interface", signature, node, isExported);
		} else if (ts.isTypeAliasDeclaration(node)) {
			const name = node.name.getText(sourceFile);
			const typeParams = formatTypeParameters(node.typeParameters, sourceFile);
			const typeVal = node.type.getText(sourceFile);
			const signature = `type ${name}${typeParams} = ${typeVal};`;

			addSymbol(name, "typeAlias", signature, node, isExported);
		} else if (ts.isEnumDeclaration(node)) {
			const name = node.name.getText(sourceFile);
			const members = node.members.map((m) => `  ${m.getText(sourceFile)}`).join(",\n");
			const signature = `enum ${name} {\n${members}\n}`;

			addSymbol(name, "enum", signature, node, isExported);
		} else if (ts.isClassDeclaration(node)) {
			const name = node.name?.getText(sourceFile) || (isDefault ? "default" : "AnonymousClass");
			const typeParams = formatTypeParameters(node.typeParameters, sourceFile);
			const memberSigs: string[] = [];

			for (const member of node.members) {
				const isPrivate = hasModifier(member, ts.SyntaxKind.PrivateKeyword);
				if (isPrivate) continue;

				if (ts.isConstructorDeclaration(member)) {
					const params = formatParameters(member.parameters, sourceFile);
					memberSigs.push(`  constructor(${params});`);
				} else if (ts.isMethodDeclaration(member)) {
					const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword);
					const isAsync = hasModifier(member, ts.SyntaxKind.AsyncKeyword);
					const mName = member.name.getText(sourceFile);
					const mTypeParams = formatTypeParameters(member.typeParameters, sourceFile);
					const mParams = formatParameters(member.parameters, sourceFile);
					const mRet = member.type ? `: ${member.type.getText(sourceFile)}` : "";
					const staticPre = isStatic ? "static " : "";
					const asyncPre = isAsync ? "async " : "";
					memberSigs.push(`  ${staticPre}${asyncPre}${mName}${mTypeParams}(${mParams})${mRet};`);
				} else if (ts.isPropertyDeclaration(member)) {
					const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword);
					const pName = member.name.getText(sourceFile);
					const pType = member.type ? `: ${member.type.getText(sourceFile)}` : "";
					const staticPre = isStatic ? "static " : "";
					memberSigs.push(`  ${staticPre}${pName}${pType};`);
				}
			}

			const signature = `class ${name}${typeParams} {\n${memberSigs.join("\n")}\n}`;
			addSymbol(name, "class", signature, node, isExported || isDefault, isDefault);
		} else if (ts.isVariableStatement(node)) {
			const isConst = Boolean(node.declarationList.flags & ts.NodeFlags.Const);
			for (const decl of node.declarationList.declarations) {
				const name = decl.name.getText(sourceFile);
				if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
					const fn = decl.initializer;
					const params = formatParameters(fn.parameters, sourceFile);
					const retType = fn.type ? `: ${fn.type.getText(sourceFile)}` : (decl.type ? `: ${decl.type.getText(sourceFile)}` : "");
					const signature = `const ${name}: (${params})${retType ? " => " + fn.type?.getText(sourceFile) : ""};`;
					addSymbol(name, "function", signature, node, isExported);
				} else {
					const kind: SymbolKind = isConst ? "constant" : "variable";
					const typeStr = decl.type ? `: ${decl.type.getText(sourceFile)}` : "";
					const signature = `${isConst ? "const" : "let"} ${name}${typeStr};`;
					addSymbol(name, kind, signature, node, isExported);
				}
			}
		} else if (ts.isImportDeclaration(node)) {
			if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
				const specifier = node.moduleSpecifier.text;
				if (!imports.includes(specifier)) {
					imports.push(specifier);
				}
			}
		} else if (ts.isExportDeclaration(node)) {
			if (node.exportClause && ts.isNamedExports(node.exportClause)) {
				for (const element of node.exportClause.elements) {
					const expName = element.name.getText(sourceFile);
					if (!exports.includes(expName)) {
						exports.push(expName);
					}
				}
			} else if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
				const reexport = `* from ${node.moduleSpecifier.text}`;
				if (!exports.includes(reexport)) {
					exports.push(reexport);
				}
				if (!imports.includes(node.moduleSpecifier.text)) {
					imports.push(node.moduleSpecifier.text);
				}
			}
		} else if (ts.isExportAssignment(node)) {
			if (!exports.includes("default")) {
				exports.push("default");
			}
		}
	}

	return {
		path: filePath,
		sha,
		symbols,
		imports: imports.sort(),
		exports: exports.sort(),
	};
}

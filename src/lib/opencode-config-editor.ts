import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";

import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  type ParseError,
  parse,
  parseTree,
} from "jsonc-parser";

import type { ConfigFileFormat, EditableConfigPath } from "./config-file-utils.js";
import {
  assertNotSymlinkSource,
  assertSameConfigWriteTarget,
  ConfigWriteTargetError,
  type ConfigWriteTargetSnapshot,
  resolveConfigWriteTarget,
  writeResolvedConfigText,
} from "./config-write-target.js";

export interface ManagedConfigComment {
  path: (string | number)[];
  text: string;
}

export interface ManagedConfigCommentReplacement {
  from: string;
  to: string;
}

export interface ConfigDocumentEdit {
  path: string;
  sourcePath: string;
  removeSourcePath?: string;
  format: ConfigFileFormat;
  originalBytes: Buffer | null;
  targetOriginalBytes: Buffer | null;
  writeTarget: ConfigWriteTargetSnapshot;
  sourceWriteTarget?: ConfigWriteTargetSnapshot;
  updated: string;
  changed: boolean;
}

export class ConfigDocumentError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "ConfigDocumentError";
  }
}

function asConfigDocumentError(error: unknown, fallbackPath: string): never {
  if (error instanceof ConfigDocumentError) {
    throw error;
  }
  if (error instanceof ConfigWriteTargetError) {
    throw new ConfigDocumentError(error.message, error.path);
  }
  throw error instanceof Error
    ? error
    : new ConfigDocumentError(`Failed inspecting config: ${fallbackPath}`, fallbackPath);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseErrors(
  raw: string,
  format: ConfigFileFormat,
): {
  value: unknown;
  errors: ParseError[];
} {
  const errors: ParseError[] = [];
  const value = parse(raw, errors, {
    allowTrailingComma: format === "jsonc",
    disallowComments: format === "json",
  });
  return { value, errors };
}

export function parseConfigDocument(
  raw: string,
  format: ConfigFileFormat,
  path: string,
): Record<string, unknown> {
  const parsed = parseErrors(raw, format);
  if (parsed.errors.length > 0) {
    throw new ConfigDocumentError(`Cannot parse ${format.toUpperCase()} config: ${path}`, path);
  }
  if (!isPlainObject(parsed.value)) {
    throw new ConfigDocumentError(`Config root must be an object: ${path}`, path);
  }
  return parsed.value;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectValueEdits(
  current: unknown,
  desired: unknown,
  path: (string | number)[],
  edits: Array<{ path: (string | number)[]; value: unknown }>,
): void {
  if (jsonEqual(current, desired)) {
    return;
  }

  if (isPlainObject(current) && isPlainObject(desired)) {
    for (const [key, value] of Object.entries(desired)) {
      collectValueEdits(current[key], value, [...path, key], edits);
    }
    return;
  }

  if (Array.isArray(current) && Array.isArray(desired)) {
    const prefixMatches =
      desired.length >= current.length &&
      current.every((value, index) => jsonEqual(value, desired[index]));
    if (prefixMatches) {
      for (let index = current.length; index < desired.length; index++) {
        edits.push({ path: [...path, -1], value: desired[index] });
      }
      return;
    }

    const keyedObjectPrefixMatches =
      desired.length >= current.length &&
      current.every((value, index) => {
        const desiredValue = desired[index];
        return (
          isPlainObject(value) &&
          isPlainObject(desiredValue) &&
          typeof value.id === "string" &&
          value.id === desiredValue.id
        );
      });
    if (keyedObjectPrefixMatches) {
      for (let index = 0; index < current.length; index++) {
        const currentValue = current[index] as Record<string, unknown>;
        const desiredValue = desired[index] as Record<string, unknown>;
        for (const key of Object.keys(currentValue)) {
          if (!Object.hasOwn(desiredValue, key)) {
            edits.push({ path: [...path, index, key], value: undefined });
          }
        }
        collectValueEdits(currentValue, desiredValue, [...path, index], edits);
      }
      for (let index = current.length; index < desired.length; index++) {
        edits.push({ path: [...path, -1], value: desired[index] });
      }
      return;
    }

    if (desired.length < current.length) {
      let desiredIndex = 0;
      const removedIndexes: number[] = [];
      for (let currentIndex = 0; currentIndex < current.length; currentIndex++) {
        if (
          desiredIndex < desired.length &&
          jsonEqual(current[currentIndex], desired[desiredIndex])
        ) {
          desiredIndex++;
        } else {
          removedIndexes.push(currentIndex);
        }
      }
      if (desiredIndex === desired.length) {
        for (const removedIndex of removedIndexes.reverse()) {
          edits.push({ path: [...path, removedIndex], value: undefined });
        }
        return;
      }
    }
  }

  edits.push({ path, value: desired });
}

function removeArrayElementPreservingSiblings(
  raw: string,
  path: (string | number)[],
): string | undefined {
  const tree = parseTree(raw, [], {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const node = tree ? findNodeAtLocation(tree, path) : undefined;
  const parent = node?.parent;
  if (!node || !parent || parent.type !== "array" || !parent.children) {
    return undefined;
  }

  const index = parent.children.indexOf(node);
  if (index < 0) return undefined;

  if (parent.children.length === 1) {
    return raw.slice(0, node.offset) + raw.slice(node.offset + node.length);
  }

  if (index < parent.children.length - 1) {
    const next = parent.children[index + 1];
    const between = raw.slice(node.offset + node.length, next.offset);
    const commaOffset = between.indexOf(",");
    if (commaOffset < 0) return undefined;
    const removeEnd = node.offset + node.length + commaOffset + 1;
    return raw.slice(0, node.offset) + raw.slice(removeEnd);
  }

  const previous = parent.children[index - 1];
  const between = raw.slice(previous.offset + previous.length, node.offset);
  const commaOffset = between.lastIndexOf(",");
  if (commaOffset < 0) return undefined;
  const removeStart = previous.offset + previous.length + commaOffset;
  return raw.slice(0, removeStart) + raw.slice(node.offset + node.length);
}

function replaceManagedComments(raw: string, replacement: ManagedConfigCommentReplacement): string {
  const scanner = createScanner(raw, false);
  const offsets: number[] = [];

  while (scanner.getPosition() < raw.length) {
    scanner.scan();
    const offset = scanner.getTokenOffset();
    const token = raw.slice(offset, offset + scanner.getTokenLength());
    if (token === replacement.from) {
      offsets.push(offset);
    }
  }

  let updated = raw;
  for (const offset of offsets.reverse()) {
    updated =
      updated.slice(0, offset) + replacement.to + updated.slice(offset + replacement.from.length);
  }
  return updated;
}

function addManagedComment(raw: string, comment: ManagedConfigComment): string {
  if (raw.includes(comment.text)) {
    return raw;
  }

  const tree = parseTree(raw, [], {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const valueNode = tree ? findNodeAtLocation(tree, comment.path) : undefined;
  const propertyNode = valueNode?.parent;
  if (!propertyNode || propertyNode.type !== "property") {
    return raw;
  }

  const lineStart = raw.lastIndexOf("\n", propertyNode.offset - 1) + 1;
  const indentation = raw.slice(lineStart, propertyNode.offset);
  if (!/^\s*$/.test(indentation)) {
    return raw;
  }

  return raw.slice(0, lineStart) + `${indentation}${comment.text}\n` + raw.slice(lineStart);
}

export function editConfigDocumentPaths(params: {
  raw: string;
  format: ConfigFileFormat;
  path: string;
  edits: Array<{ path: (string | number)[]; value: unknown }>;
}): string {
  let updated = params.raw;
  for (const edit of params.edits) {
    const removed =
      edit.value === undefined
        ? removeArrayElementPreservingSiblings(updated, edit.path)
        : undefined;
    updated = removed ?? applyEdits(updated, modify(updated, edit.path, edit.value, {}));
  }
  parseConfigDocument(updated, params.format, params.path);
  return updated;
}

export function editConfigDocument(params: {
  raw: string;
  sourceFormat: ConfigFileFormat;
  outputFormat: ConfigFileFormat;
  path: string;
  desiredData: Record<string, unknown>;
  managedComments?: ManagedConfigComment[];
  managedCommentReplacements?: ManagedConfigCommentReplacement[];
}): string {
  const current = parseConfigDocument(params.raw, params.sourceFormat, params.path);
  const edits: Array<{ path: (string | number)[]; value: unknown }> = [];
  collectValueEdits(current, params.desiredData, [], edits);

  const eol = params.raw.includes("\r\n") ? "\r\n" : "\n";
  let updated = params.raw;
  for (const edit of edits) {
    const removed =
      edit.value === undefined
        ? removeArrayElementPreservingSiblings(updated, edit.path)
        : undefined;
    updated =
      removed ??
      applyEdits(
        updated,
        modify(updated, edit.path, edit.value, {
          formattingOptions: {
            insertSpaces: true,
            tabSize: 2,
            eol,
          },
        }),
      );
  }

  if (params.outputFormat === "jsonc") {
    for (const replacement of params.managedCommentReplacements ?? []) {
      updated = replaceManagedComments(updated, replacement);
    }
    for (const comment of params.managedComments ?? []) {
      updated = addManagedComment(updated, comment);
    }
  }

  if (!updated.endsWith(eol)) {
    updated += eol;
  }

  parseConfigDocument(updated, params.outputFormat, params.path);
  return updated;
}

export async function planConfigDocumentEdit(params: {
  target: EditableConfigPath;
  desiredData: Record<string, unknown>;
  managedComments?: ManagedConfigComment[];
  managedCommentReplacements?: ManagedConfigCommentReplacement[];
}): Promise<ConfigDocumentEdit> {
  let writeTarget: ConfigWriteTargetSnapshot;
  let sourceWriteTarget: ConfigWriteTargetSnapshot | undefined;
  try {
    writeTarget = await resolveConfigWriteTarget(params.target.path);
    if (params.target.sourcePath !== params.target.path) {
      sourceWriteTarget = await resolveConfigWriteTarget(params.target.sourcePath);
      if (params.target.removeSourcePath) {
        assertNotSymlinkSource(sourceWriteTarget, params.target.sourcePath);
      }
    } else if (params.target.removeSourcePath) {
      assertNotSymlinkSource(writeTarget, params.target.sourcePath);
    }
  } catch (error) {
    asConfigDocumentError(error, params.target.path);
  }

  const originalBytes = params.target.existed
    ? await readFile((sourceWriteTarget ?? writeTarget).writePath)
    : null;
  const originalRaw = originalBytes?.toString("utf8") ?? "{}\n";
  const sourceFormat: ConfigFileFormat = params.target.sourcePath.endsWith(".jsonc")
    ? "jsonc"
    : "json";
  const convertingJsonToJsonc = sourceFormat === "json" && params.target.format === "jsonc";
  const raw = convertingJsonToJsonc ? "{}\n" : originalRaw;
  const updated = editConfigDocument({
    raw,
    sourceFormat,
    outputFormat: params.target.format,
    path: params.target.path,
    desiredData: params.desiredData,
    managedComments: params.managedComments,
    managedCommentReplacements: params.managedCommentReplacements,
  });
  const targetOriginalBytes =
    params.target.path === params.target.sourcePath
      ? originalBytes
      : writeTarget.terminalExisted
        ? await readFile(writeTarget.writePath)
        : null;

  return {
    path: params.target.path,
    sourcePath: params.target.sourcePath,
    removeSourcePath: params.target.removeSourcePath,
    format: params.target.format,
    originalBytes,
    targetOriginalBytes,
    writeTarget,
    ...(sourceWriteTarget ? { sourceWriteTarget } : {}),
    updated,
    changed:
      updated !== raw || params.target.path !== params.target.sourcePath || !params.target.existed,
  };
}

export async function validateConfigDocumentEdit(
  edit: ConfigDocumentEdit,
  options: {
    readBytes?: (path: string) => Promise<Buffer>;
    pathExists?: (path: string) => boolean;
  } = {},
): Promise<void> {
  if (!edit.changed) {
    return;
  }

  const readBytes = options.readBytes ?? ((path: string) => readFile(path));
  const pathExists = options.pathExists ?? existsSync;

  const sourceWritePath = (edit.sourceWriteTarget ?? edit.writeTarget).writePath;
  if (edit.originalBytes === null) {
    if (pathExists(sourceWritePath)) {
      throw new ConfigDocumentError(
        `Config changed since preview: ${edit.sourcePath}`,
        edit.sourcePath,
      );
    }
  } else {
    let current: Buffer;
    try {
      current = await readBytes(sourceWritePath);
    } catch {
      throw new ConfigDocumentError(`Failed reading config: ${edit.sourcePath}`, edit.sourcePath);
    }
    if (!current.equals(edit.originalBytes)) {
      throw new ConfigDocumentError(
        `Config changed since preview: ${edit.sourcePath}`,
        edit.sourcePath,
      );
    }
  }

  if (edit.path !== edit.sourcePath) {
    if (edit.targetOriginalBytes === null) {
      if (pathExists(edit.writeTarget.writePath)) {
        throw new ConfigDocumentError(
          `Config target appeared since preview: ${edit.path}`,
          edit.path,
        );
      }
    } else {
      let currentTarget: Buffer;
      try {
        currentTarget = await readBytes(edit.writeTarget.writePath);
      } catch {
        throw new ConfigDocumentError(`Failed reading config target: ${edit.path}`, edit.path);
      }
      if (!currentTarget.equals(edit.targetOriginalBytes)) {
        throw new ConfigDocumentError(
          `Config target changed since preview: ${edit.path}`,
          edit.path,
        );
      }
    }
  }

  try {
    const currentTarget = await resolveConfigWriteTarget(edit.path);
    assertSameConfigWriteTarget(edit.writeTarget, currentTarget);
    if (edit.sourceWriteTarget) {
      const currentSource = await resolveConfigWriteTarget(edit.sourcePath);
      assertSameConfigWriteTarget(edit.sourceWriteTarget, currentSource);
      if (edit.removeSourcePath) {
        assertNotSymlinkSource(currentSource, edit.sourcePath);
      }
    } else if (edit.removeSourcePath) {
      assertNotSymlinkSource(currentTarget, edit.sourcePath);
    }
  } catch (error) {
    asConfigDocumentError(error, edit.path);
  }
}

export async function applyConfigDocumentEdit(
  edit: ConfigDocumentEdit,
  options: {
    readBytes?: (path: string) => Promise<Buffer>;
    pathExists?: (path: string) => boolean;
    writeText?: (path: string, content: string) => Promise<void>;
    removePath?: (path: string) => Promise<void>;
  } = {},
): Promise<void> {
  if (!edit.changed) {
    return;
  }

  await validateConfigDocumentEdit(edit, options);

  const removePath = options.removePath ?? ((path: string) => rm(path));
  try {
    const currentTarget = await resolveConfigWriteTarget(edit.path);
    assertSameConfigWriteTarget(edit.writeTarget, currentTarget);
    if (options.writeText) {
      await options.writeText(currentTarget.writePath, edit.updated);
    } else {
      await writeResolvedConfigText(currentTarget, edit.updated);
    }
  } catch (error) {
    asConfigDocumentError(error, edit.path);
  }

  if (!edit.removeSourcePath) {
    return;
  }

  try {
    await removePath(edit.removeSourcePath);
  } catch {
    if (edit.targetOriginalBytes === null) {
      try {
        await removePath(edit.path);
      } catch {
        // Best effort: the original source is still intact and remains the rollback authority.
      }
    }
    throw new ConfigDocumentError(
      `Failed removing converted config source: ${edit.removeSourcePath}`,
      edit.removeSourcePath,
    );
  }
}

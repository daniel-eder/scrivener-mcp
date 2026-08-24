/**
 * Unified Document Operations Utility
 * Provides transaction-wrapped document operations with consistent error handling
 */

import { generateScrivenerUUID } from './scrivener-utils.js';
import { toScrivenerDateString } from './scrivx-serializer.js';
import { createError, ErrorCode } from '../core/errors.js';
import { getLogger } from '../core/logger.js';
import type { LogContext } from '../core/logger.js';
// import type { BinderItem, BinderContainer } from '../types/scrivx.js';

interface BinderItem {
	UUID: string;
	Type?: string;
	Title?: string;
	Created?: string;
	Modified?: string;
	Children?: ChildrenContainer;
	MetaData?: Record<string, unknown>;
}

/**
 * Matches the on-disk .scrivx model: children live in a container element
 * (e.g. `<Children><BinderItem .../></Children>`), not a flat array.
 */
interface ChildrenContainer {
	BinderItem?: BinderItem | BinderItem[];
}

interface BinderContainer {
	BinderItem?: BinderItem | BinderItem[];
}

/**
 * Normalize an item's Children container to a flat array of binder items.
 */
function getChildrenArray(item: BinderItem): BinderItem[] {
	const container = item.Children as ChildrenContainer | undefined;
	if (!container || typeof container !== 'object') {
		return [];
	}
	if (Array.isArray(container.BinderItem)) {
		return container.BinderItem;
	}
	return container.BinderItem ? [container.BinderItem] : [];
}

/**
 * Append a child to an item's Children container, creating it if needed.
 */
function appendChild(item: BinderItem, child: BinderItem): void {
	if (!item.Children || typeof item.Children !== 'object' || Array.isArray(item.Children)) {
		item.Children = {};
	}
	const container = item.Children as ChildrenContainer;
	if (!container.BinderItem) {
		container.BinderItem = [];
	} else if (!Array.isArray(container.BinderItem)) {
		container.BinderItem = [container.BinderItem];
	}
	(container.BinderItem as BinderItem[]).push(child);
}

const logger = getLogger('document-operations');

export interface DocumentCreationOptions {
	title: string;
	content?: string;
	parentId?: string;
	type?: 'Text' | 'Folder';
	metadata?: {
		synopsis?: string;
		notes?: string;
		label?: string;
		status?: string;
		keywords?: string[];
	};
}

export interface DocumentCreationResult {
	id: string;
	path: string[];
	created: Date;
}

export interface DocumentOperationContext {
	projectStructure: unknown;
	projectPath: string;
	writeDocument?: (id: string, content: string) => Promise<void>;
	saveProject?: () => Promise<void>;
}

/**
 * Transaction wrapper for document operations
 * Ensures atomic operations with proper rollback on failure
 */
export async function withDocumentTransaction<T>(
	operation: () => Promise<T>,
	context: DocumentOperationContext,
	operationName: string = 'document operation'
): Promise<T> {
	const startTime = Date.now();
	let result: T;

	try {
		logger.debug(`Starting transaction: ${operationName}`);

		// Execute the operation
		result = await operation();

		// Save project if save function is provided
		if (context.saveProject) {
			await context.saveProject();
		}

		const duration = Date.now() - startTime;
		logger.info(`Transaction completed: ${operationName} (${duration}ms)`);

		return result;
	} catch (error) {
		const duration = Date.now() - startTime;
		logger.error(`Transaction failed: ${operationName} (${duration}ms)`, error as LogContext);

		// Re-throw as structured error
		if (error instanceof Error) {
			throw createError(
				ErrorCode.TRANSACTION_ERROR,
				error,
				`Failed to complete ${operationName}: ${error.message}`
			);
		}
		throw createError(
			ErrorCode.TRANSACTION_ERROR,
			undefined,
			`Failed to complete ${operationName}`
		);
	}
}

/**
 * Unified document creation with transaction support
 * Replaces duplicate createDocument implementations across the codebase
 */
export async function createDocument(
	options: DocumentCreationOptions,
	context: DocumentOperationContext
): Promise<DocumentCreationResult> {
	return withDocumentTransaction(
		async () => {
			// Validate project structure
			const projectStructure = context.projectStructure as {
				ScrivenerProject?: { Binder?: BinderContainer };
			};
			if (!projectStructure?.ScrivenerProject?.Binder) {
				throw createError(ErrorCode.INVALID_STATE, undefined, 'Project not loaded');
			}

			const binder = projectStructure.ScrivenerProject.Binder as BinderContainer;
			const id = generateScrivenerUUID();
			const type = options.type || 'Text';

			// Create the document file if it's a text document
			if (type === 'Text' && context.writeDocument) {
				await context.writeDocument(id, options.content || '');
			}

			// Create the binder item
			const now = toScrivenerDateString();
			const newItem: BinderItem = {
				UUID: id,
				Type: type,
				Title: options.title,
				Created: now,
				Modified: now,
				Children: type === 'Folder' ? {} : undefined,
			};

			// Scrivener expects IncludeInCompile on every binder item; user
			// metadata keys are stored alongside it.
			newItem.MetaData = {
				IncludeInCompile: 'Yes',
				...(options.metadata?.synopsis ? { Synopsis: options.metadata.synopsis } : {}),
				...(options.metadata?.label ? { Label: options.metadata.label } : {}),
				...(options.metadata?.status ? { Status: options.metadata.status } : {}),
			} as Record<string, unknown>;

			// Find parent and add item
			let parentPath: string[] = [];
			if (options.parentId) {
				const parent = findBinderItem(binder, options.parentId);
				if (!parent.item) {
					throw createError(
						ErrorCode.NOT_FOUND,
						undefined,
						`Parent folder not found: ${options.parentId}`
					);
				}
				if (parent.item.Type !== 'Folder' && parent.item.Type !== 'DraftFolder') {
					throw createError(
						ErrorCode.INVALID_REQUEST,
						undefined,
						'Parent must be a folder'
					);
				}

				// Add to parent's children
				appendChild(parent.item, newItem);
				parentPath = parent.path;
			} else {
				// Add to root draft folder by default
				const draftFolder = Array.isArray(binder.BinderItem)
					? binder.BinderItem[0]
					: binder.BinderItem;
				if (
					draftFolder &&
					(draftFolder.Type === 'Folder' || draftFolder.Type === 'DraftFolder')
				) {
					appendChild(draftFolder, newItem);
					parentPath = [draftFolder.Title || 'Draft'];
				} else {
					// Fallback: add to root
					if (!binder.BinderItem) {
						binder.BinderItem = [];
					}
					if (Array.isArray(binder.BinderItem)) {
						binder.BinderItem.push(newItem);
					}
				}
			}

			// Update modified timestamp on parent
			const parentModified = toScrivenerDateString();
			if (options.parentId) {
				const parent = findBinderItem(binder, options.parentId);
				if (parent.item) {
					parent.item.Modified = parentModified;
				}
			}

			logger.info(`Document created: ${id} (${options.title})`);

			return {
				id,
				path: [...parentPath, options.title],
				created: new Date(),
			};
		},
		context,
		`create document "${options.title}"`
	);
}

/**
 * Batch document creation with transaction support
 */
export async function createDocuments(
	documents: DocumentCreationOptions[],
	context: DocumentOperationContext
): Promise<DocumentCreationResult[]> {
	return withDocumentTransaction(
		async () => {
			const results: DocumentCreationResult[] = [];

			for (const doc of documents) {
				// Create each document within the same transaction
				// Note: We don't use nested transactions here
				const projectStructure = context.projectStructure as {
					ScrivenerProject?: { Binder?: BinderContainer };
				};
				if (!projectStructure?.ScrivenerProject?.Binder) {
					throw createError(ErrorCode.INVALID_STATE, undefined, 'Project not loaded');
				}

				const binder = projectStructure.ScrivenerProject.Binder as BinderContainer;
				const id = generateScrivenerUUID();
				const type = doc.type || 'Text';

				// Create the document file if it's a text document
				if (type === 'Text' && context.writeDocument) {
					await context.writeDocument(id, doc.content || '');
				}

				// Create the binder item
				const now = toScrivenerDateString();
				const newItem: BinderItem = {
					UUID: id,
					Type: type,
					Title: doc.title,
					Created: now,
					Modified: now,
					Children: type === 'Folder' ? {} : undefined,
				};

				// Scrivener expects IncludeInCompile on every binder item
				newItem.MetaData = {
					IncludeInCompile: 'Yes',
					...(doc.metadata?.synopsis ? { Synopsis: doc.metadata.synopsis } : {}),
					...(doc.metadata?.label ? { Label: doc.metadata.label } : {}),
					...(doc.metadata?.status ? { Status: doc.metadata.status } : {}),
				} as Record<string, unknown>;

				// Find parent and add item
				let parentPath: string[] = [];
				if (doc.parentId) {
					const parent = findBinderItem(binder, doc.parentId);
					if (!parent.item) {
						throw createError(
							ErrorCode.NOT_FOUND,
							undefined,
							`Parent folder not found: ${doc.parentId}`
						);
					}
					if (parent.item.Type !== 'Folder' && parent.item.Type !== 'DraftFolder') {
						throw createError(
							ErrorCode.INVALID_REQUEST,
							undefined,
							'Parent must be a folder'
						);
					}

					// Add to parent's children
					appendChild(parent.item, newItem);
					parentPath = parent.path;
				} else {
					// Add to root draft folder by default
					const draftFolder = Array.isArray(binder.BinderItem)
						? binder.BinderItem[0]
						: binder.BinderItem;
					if (
						draftFolder &&
						(draftFolder.Type === 'Folder' || draftFolder.Type === 'DraftFolder')
					) {
						appendChild(draftFolder, newItem);
						parentPath = [draftFolder.Title || 'Draft'];
					} else {
						// Fallback: add to root
						if (!binder.BinderItem) {
							binder.BinderItem = [];
						}
						if (Array.isArray(binder.BinderItem)) {
							binder.BinderItem.push(newItem);
						}
					}
				}

				results.push({
					id,
					path: [...parentPath, doc.title],
					created: new Date(),
				});
			}

			logger.info(`Batch created ${documents.length} documents`);
			return results;
		},
		context,
		`batch create ${documents.length} documents`
	);
}

/**
 * Helper function to find a binder item by ID
 */
function findBinderItem(
	binder: BinderContainer,
	id: string,
	path: string[] = []
): { item: BinderItem | null; path: string[] } {
	const searchItems = (
		items: BinderItem[],
		currentPath: string[]
	): { item: BinderItem | null; path: string[] } => {
		for (const item of items) {
			if (item.UUID === id) {
				return { item, path: currentPath };
			}
			const children = getChildrenArray(item);
			if (children.length > 0) {
				const found = searchItems(children, [...currentPath, item.Title || '']);
				if (found.item) {
					return found;
				}
			}
		}
		return { item: null, path: [] };
	};

	if (Array.isArray(binder.BinderItem)) {
		return searchItems(binder.BinderItem, path);
	} else if (binder.BinderItem) {
		return searchItems([binder.BinderItem], path);
	}

	return { item: null, path: [] };
}

/**
 * Move document with transaction support
 */
export async function moveDocument(
	documentId: string,
	targetParentId: string,
	context: DocumentOperationContext
): Promise<void> {
	return withDocumentTransaction(
		async () => {
			const projectStructure = context.projectStructure as {
				ScrivenerProject?: { Binder?: BinderContainer };
			};
			if (!projectStructure?.ScrivenerProject?.Binder) {
				throw createError(ErrorCode.INVALID_STATE, undefined, 'Project not loaded');
			}

			const binder = projectStructure.ScrivenerProject.Binder as BinderContainer;

			// Find the document
			const docResult = findBinderItem(binder, documentId);
			if (!docResult.item) {
				throw createError(
					ErrorCode.NOT_FOUND,
					undefined,
					`Document not found: ${documentId}`
				);
			}

			// Find target parent
			const targetResult = findBinderItem(binder, targetParentId);
			if (!targetResult.item) {
				throw createError(
					ErrorCode.NOT_FOUND,
					undefined,
					`Target folder not found: ${targetParentId}`
				);
			}
			if (targetResult.item.Type !== 'Folder') {
				throw createError(ErrorCode.INVALID_REQUEST, undefined, 'Target must be a folder');
			}

			// Remove from current parent
			const removeFromParent = (items: BinderItem[]): boolean => {
				for (let i = 0; i < items.length; i++) {
					if (items[i].UUID === documentId) {
						items.splice(i, 1);
						return true;
					}
					const children = getChildrenArray(items[i]);
					if (children.length > 0 && removeFromParent(children)) {
						return true;
					}
				}
				return false;
			};

			if (Array.isArray(binder.BinderItem)) {
				removeFromParent(binder.BinderItem);
			}

			// Add to target parent
			appendChild(targetResult.item, docResult.item);

			// Update timestamps
			const now = toScrivenerDateString();
			docResult.item.Modified = now;
			targetResult.item.Modified = now;

			logger.info(`Document moved: ${documentId} -> ${targetParentId}`);
		},
		context,
		`move document ${documentId}`
	);
}

/**
 * Delete document with transaction support
 */
export async function deleteDocument(
	documentId: string,
	context: DocumentOperationContext,
	moveToTrash: boolean = true
): Promise<void> {
	return withDocumentTransaction(
		async () => {
			const projectStructure = context.projectStructure as {
				ScrivenerProject?: { Binder?: BinderContainer };
			};
			if (!projectStructure?.ScrivenerProject?.Binder) {
				throw createError(ErrorCode.INVALID_STATE, undefined, 'Project not loaded');
			}

			const binder = projectStructure.ScrivenerProject.Binder as BinderContainer;

			if (moveToTrash) {
				// Find or create trash folder
				let trashFolder: BinderItem | undefined;
				if (Array.isArray(binder.BinderItem)) {
					trashFolder = binder.BinderItem.find(
						(item: BinderItem) => item.Title === 'Trash' && item.Type === 'Folder'
					);
					if (!trashFolder) {
						trashFolder = {
							UUID: generateScrivenerUUID(),
							Type: 'Folder',
							Title: 'Trash',
							Created: toScrivenerDateString(),
							Modified: toScrivenerDateString(),
							Children: {},
						};
						binder.BinderItem.push(trashFolder);
					}
				}

				if (trashFolder) {
					// Move to trash
					await moveDocument(documentId, trashFolder.UUID, context);
					logger.info(`Document moved to trash: ${documentId}`);
				}
			} else {
				// Permanently delete
				const removeFromItems = (items: BinderItem[]): boolean => {
					for (let i = 0; i < items.length; i++) {
						if (items[i].UUID === documentId) {
							items.splice(i, 1);
							return true;
						}
						const children = getChildrenArray(items[i]);
						if (children.length > 0 && removeFromItems(children)) {
							return true;
						}
					}
					return false;
				};

				if (Array.isArray(binder.BinderItem)) {
					if (removeFromItems(binder.BinderItem)) {
						logger.info(`Document permanently deleted: ${documentId}`);
					} else {
						throw createError(
							ErrorCode.NOT_FOUND,
							undefined,
							`Document not found: ${documentId}`
						);
					}
				}
			}
		},
		context,
		`delete document ${documentId}`
	);
}

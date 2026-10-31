/**
 * Migration Manager
 * Handles safe migration of existing documents to Knowledge Hub
 */

import * as path from 'path';
import {
  DEFAULT_HUB_PATH,
  ExistingDocument,
  MigrationResult,
  MigratedFile,
  SkippedMigration,
  MigrationError
} from '../types.js';
import {
  fileExists,
  safeMoveFile,
  getFileStats,
  listFilesRecursive
} from '../utils/fileUtils.js';
import { createBackup } from '../utils/backupUtils.js';
import { resolveContainedEntry } from '../../../security/pathGuard.js';
import { pathExistsNoFollow } from '../../../utils/safeWrite.js';

// Known document patterns to migrate
const KNOWN_DOCUMENTS = [
  'INDEX.md',
  'FIELD_DICTIONARY.md',
  'PROJECT_STRUCTURE.md',
  'API_REFERENCE.md',
  'TECH_STACK.md'
];

export type MigrationAction = 'move' | 'keep';

/**
 * Pure (SEC-20). A root document moves only to a place where nothing is yet. A file that
 * the hub already has is kept, and so is the root file: nothing is replaced.
 */
export function migrationAction(targetExists: boolean): MigrationAction {
  return targetExists ? 'keep' : 'move';
}

export class MigrationManager {
  constructor(private projectPath: string) {}
  
  /**
   * Scan for existing documents that should be migrated
   */
  async scanExistingDocuments(): Promise<ExistingDocument[]> {
    const existing: ExistingDocument[] = [];
    
    for (const docName of KNOWN_DOCUMENTS) {
      const docPath = path.join(this.projectPath, docName);
      
      if (await fileExists(docPath)) {
        const stats = await getFileStats(docPath);
        
        // Determine target location based on document name
        const targetLocation = this.determineTargetLocation(docName);
        
        existing.push({
          path: docPath,
          name: docName,
          size: Number(stats.size),
          modified: stats.mtime,
          target_location: targetLocation
        });
      }
    }
    
    return existing;
  }
  
  /**
   * Migrate documents to Knowledge Hub.
   * A document whose target already exists is kept as it is and listed in `skipped_files`.
   * A target whose folder leads out of the project through a symlink is refused.
   */
  async migrate(documents: ExistingDocument[]): Promise<MigrationResult> {
    if (documents.length === 0) {
      return {
        success: true,
        message: 'No documents to migrate',
        migrated_count: 0
      };
    }
    
    try {
      // Decide first, move later: nothing is touched until every target is known.
      const toMove: Array<{ doc: ExistingDocument; target: string }> = [];
      const kept: SkippedMigration[] = [];
      const errors: string[] = [];
      
      for (const doc of documents) {
        const target = await resolveContainedEntry(
          this.projectPath,
          path.join(DEFAULT_HUB_PATH, doc.target_location)
        );
        if (target === null) {
          errors.push(`Refused ${doc.name}: its place in the knowledge hub is outside the project`);
          continue;
        }
        if (migrationAction(await pathExistsNoFollow(target)) === 'keep') {
          kept.push({ original_path: doc.path, existing_target: target });
          continue;
        }
        toMove.push({ doc, target });
      }
      
      // Back up only what is going to move
      let backupLocation: string | undefined;
      if (toMove.length > 0) {
        const backup = await createBackup(
          toMove.map(m => m.doc.path),
          this.projectPath,
          '.m7/backups/knowledge-hub/'
        );
        backupLocation = backup.location;
      }
      
      // Migrate each document
      const migratedFiles: MigratedFile[] = [];
      
      for (const { doc, target } of toMove) {
        try {
          await safeMoveFile(doc.path, target);
          
          migratedFiles.push({
            original_path: doc.path,
            new_path: target,
            size: doc.size
          });
        } catch (error: any) {
          errors.push(`Failed to migrate ${doc.name}: ${error.message}`);
        }
      }
      
      // Keeping a file is not a failure. If any migrations failed, we still consider it partial success
      const success = migratedFiles.length > 0 || errors.length === 0;
      
      let message: string;
      if (migratedFiles.length > 0) {
        message = `Successfully migrated ${migratedFiles.length} documents`;
        if (kept.length > 0) message += `; kept ${kept.length} file(s) that already exist in the hub`;
      } else if (errors.length === 0) {
        message = `Nothing migrated: ${kept.length} document(s) already exist in the hub and were kept`;
      } else {
        message = errors.join('; ');
      }
      
      return {
        success,
        message,
        migrated_count: migratedFiles.length,
        migrated_files: migratedFiles,
        skipped_files: kept.length > 0 ? kept : undefined,
        backup_location: backupLocation,
        errors: errors.length > 0 ? errors : undefined
      };
    } catch (error: any) {
      throw new MigrationError(
        `Migration failed: ${error.message}`,
        { error: error.message }
      );
    }
  }
  
  /**
   * Determine target location for a document
   */
  private determineTargetLocation(docName: string): string {
    // Map document names to their target locations
    const locationMap: Record<string, string> = {
      'INDEX.md': 'core/INDEX.md',
      'FIELD_DICTIONARY.md': 'core/FIELD_DICTIONARY.md',
      'PROJECT_STRUCTURE.md': 'core/PROJECT_STRUCTURE.md',
      'API_REFERENCE.md': 'api/API_REFERENCE.md',
      'TECH_STACK.md': 'tech/TECH_STACK.md'
    };
    
    return locationMap[docName] || `core/${docName}`;
  }
  
  /**
   * Check if migration is needed
   */
  async isMigrationNeeded(): Promise<boolean> {
    const existing = await this.scanExistingDocuments();
    return existing.length > 0;
  }
  
  /**
   * Get migration report
   */
  async getMigrationReport(): Promise<{
    documents_found: number;
    total_size: number;
    documents: ExistingDocument[];
  }> {
    const documents = await this.scanExistingDocuments();
    const totalSize = documents.reduce((sum, doc) => sum + doc.size, 0);
    
    return {
      documents_found: documents.length,
      total_size: totalSize,
      documents
    };
  }
}


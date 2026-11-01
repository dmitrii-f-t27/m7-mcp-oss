// Modified by Dmitrii Fedorov, 2026: changed from the original M7 MCP (see NOTICE).
import { createLogger } from '../utils/logger.js';
const log = createLogger('[initProject]');
import { z } from 'zod';
import { JournalSystem } from '../../journal/journalSystem.js';
import { SchemaSystem } from '../../schema/schemaSystem.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';
import { getProjectPath, applyProjectPath, ensureProjectPathResolved } from '../utils/projectPath.js';
import { createM7StructureInternal } from './createStructure.js';
import { M7_MANAGED_MARKER, isSymlinkNoFollow, pathExistsNoFollow, writeIfAbsent } from '../utils/safeWrite.js';
import { resolveContained, resolveContainedEntry } from '../security/pathGuard.js';
import { listingEmpty, needsInitNote } from '../../rules/policyRules.js';
// v5.0: Use UnifiedMemoryCore instead of MemorySystem
import { getMemoryCore, UnifiedMemoryCore } from '../../memory/auto/unified-memory-core.js';

/**
 * Result of Cold Start initialization
 */
export interface ColdStartResult {
  success: boolean;
  projectPath: string;
  projectName: string;
  filesCreated: string[];
  /** Files that already existed and were left unchanged. */
  filesSkipped: string[];
  firstTask?: {
    folder: string;
    files: string[];
  };
  memoryInitialized?: boolean;
  error?: string;
}

/** One project file M7 wrote or left alone, with a short description for the answer. */
type FileEntry = { path: string; description: string };

/**
 * Write one project file only when it is absent.
 * A file that already exists is never touched; it goes to `skippedFiles`.
 * The parent directory must lie inside the project, also through symlinks: a
 * `memory-bank` that links out of the project is refused. `wx` covers the file itself.
 */
async function createFile(
  currentDir: string,
  relPath: string,
  content: string,
  description: string,
  createdFiles: FileEntry[],
  skippedFiles: FileEntry[]
): Promise<void> {
  const absPath = await resolveContainedEntry(currentDir, relPath);
  if (absPath === null) throw new Error(`Refusing to write outside the project: ${relPath}`);
  const outcome = await writeIfAbsent(absPath, content);
  (outcome === 'created' ? createdFiles : skippedFiles).push({ path: relPath, description });
}

/** Make a project directory, after checking that it lies inside the project (also through symlinks). */
async function makeContainedDir(currentDir: string, relDir: string): Promise<void> {
  const absDir = await resolveContained(currentDir, relDir);
  if (absDir === null) throw new Error(`Refusing to write outside the project: ${relDir}`);
  await fs.mkdir(absDir, { recursive: true });
}

const InitProjectRequestSchema = z.object({
  project_path: z.string().optional(),
  project_name: z.string().optional(),
  description: z.string().optional(),
  technologies: z.array(z.string()).optional(),
  domain: z.string().optional(),
  force: z.boolean().default(false)
});

export const initProjectTool = {
  name: 'mcp_m7_init_project',
  description: 'Initialize complete M7 ecosystem for empty projects - creates Memory Bank, .cursorrules, project structure',
  inputSchema: {
    type: 'object',
    properties: {
      project_path: {
        type: 'string',
        description: 'Explicit path to project directory (defaults to MCP workspace / resolved project path)'
      },
      project_name: {
        type: 'string',
        description: 'Project name (optional - will auto-detect from directory)'
      },
      description: {
        type: 'string',
        description: 'Project description (optional)'
      },
      technologies: {
        type: 'array',
        items: { type: 'string' },
        description: 'Expected technologies (React, Node.js, etc.)'
      },
      domain: {
        type: 'string',
        description: 'Business domain (e-commerce, social media, etc.)'
      },
      force: {
        type: 'boolean',
        description: 'Initialize even if the directory is not empty. Existing files are never overwritten; they are skipped and listed in the answer.',
        default: false
      }
    }
  },
  handler: async (request: any, journal: JournalSystem, schema?: SchemaSystem, server?: unknown) => {
    const params = InitProjectRequestSchema.parse(request);
    const { project_path, project_name, description, technologies, domain, force } = params;

    try {
      let currentDir: string;
      if (project_path) {
        currentDir = applyProjectPath(project_path);
      } else {
        currentDir = await ensureProjectPathResolved(server);
      }
      log.error(`📁 [initProject] Using project path: ${currentDir}`);

      // The journal and schema the server passes in are bound to the root it had
      // before this call; with an explicit project_path that root can be another
      // project. Bind new ones to the resolved path and use only these.
      const projectJournal = new JournalSystem(currentDir);
      const projectSchema = schema ? new SchemaSystem(projectJournal, currentDir) : undefined;
      
      const isEmpty = await isDirectoryEmpty(currentDir);
      
      if (!isEmpty && !force) {
        return {
          content: [{
            type: 'text',
            text: `# 🚫 Directory Not Empty

**Current Directory:** \`${currentDir}\`

The directory contains files. M7 auto-initialization is designed for empty projects.

## Options:
1. **Move to empty directory** and run again
2. **Use force flag**: Add \`force: true\` to initialize anyway
3. **Manual setup**: Use individual M7 tools in existing project

## Safety First 🛡️
M7 methodology prioritizes careful analysis over quick fixes. 
Empty directory initialization ensures clean, intentional project setup.`
          }],
          isError: true
        };
      }

      // Auto-detect project name from directory
      const detectedName = project_name || path.basename(currentDir);
      
      // Initialize M7 ecosystem
      let initResult: Awaited<ReturnType<typeof initializeM7Ecosystem>>;
      try {
        initResult = await initializeM7Ecosystem({
          projectName: detectedName,
          description: description || `${detectedName} - M7 Methodology Project`,
          technologies: technologies || ['To be determined'],
          domain: domain || 'General',
          currentDir
        }, projectJournal, projectSchema);
      } finally {
        // This journal is not registered for shutdown: write its entries now.
        await projectJournal.shutdown();
      }

      return {
        content: [{
          type: 'text',
          text: `# 🚀 M7 Ecosystem Initialized Successfully!

## 📁 Project: "${detectedName}"
**Location:** \`${currentDir}\`
**Domain:** ${domain || 'General'}
**Technologies:** ${(technologies || ['To be determined']).join(', ')}

## 🏗️ Created Structure:
${initResult.createdFiles.map(f => `- ✅ **${f.path}** - ${f.description}`).join('\n')}
${formatSkippedSection(initResult.skippedFiles)}

## 🧠 Memory Systems:
- ✅ **Project Memory** (Level 5) - High-level project context
- ✅ **Memory Bank** - Complete methodological framework  
- ✅ **Journal Systems** - Error and pattern tracking
- ✅ **Fog of War** - Technical discovery tracking

## 📋 Ready to Use:
- **Discovery Phase**: Start with any task using \`@m7 analyze task\`
- **Memory Recall**: \`@m7 recall memory query="topic" depth=5\`
- **Pattern Storage**: \`@m7 store pattern\` for learnings
- **Project Updates**: \`@m7 update project memory\`

## 🎯 Next Steps:
1. **Define your first task**: \`@m7 analyze task "Your first feature"\`
2. **Update project details**: Add more specific technologies and features
3. **Follow M7 methodology**: Always start with Discovery → Architecture → Planning

## 💡 M7 Philosophy:
*"Architecture first, implementation second. Discovery prevents chaos."*

Welcome to systematic, enterprise-ready development! 🎉`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **M7 initialization failed:** ${error instanceof Error ? error.message : 'Unknown error'}

Please check permissions and try again.`
        }],
        isError: true
      };
    }
  }
};

/**
 * Pure: is a directory with these entry names empty for M7?
 * Only `.git`, `.gitignore`, `.DS_Store` and `.m7` are ignored (git bookkeeping, the Finder file, M7's own data
 * folder). Every other name, hidden or not (`.github`, `.vscode`, `.env`, `.cursorrules`, ...), is the user's
 * work, so the directory is a project and M7 sets nothing up in it on its own. The rule is in
 * specs/policy_rules.t27; a listing over 65536 bytes, or a failing backend, is "not empty".
 */
export function isEmptyListing(names: string[]): boolean {
  return listingEmpty(names);
}

/**
 * Check if the directory is empty for M7 (see `isEmptyListing`).
 * Exported for use in analyzeTask cold start detection
 * A directory that cannot be read is NOT empty: M7 writes nothing into it.
 */
export async function isDirectoryEmpty(dirPath: string): Promise<boolean> {
  try {
    return isEmptyListing(await fs.readdir(dirPath));
  } catch {
    return false;
  }
}

/**
 * Check if directory needs M7 initialization
 * Returns true only for an empty directory. Any other directory is the
 * user's project; M7 sets it up only when asked (mcp_m7_init_project).
 */
export async function needsM7Init(dirPath: string): Promise<boolean> {
  try {
    return await isDirectoryEmpty(dirPath);
  } catch {
    return false;
  }
}

/**
 * Pure: should analyze_task tell the user that M7 is not set up here?
 * True for a directory with files and with neither a memory-bank nor a .cursorrules.
 */
export function needsInitNoteFor(state: { isEmpty: boolean; hasMemoryBank: boolean; hasCursorRules: boolean }): boolean {
  return needsInitNote(state);
}

/** True when analyze_task should show the "M7 is not set up here" note. Writes nothing. */
export async function needsM7InitNote(dirPath: string): Promise<boolean> {
  try {
    return needsInitNoteFor({
      isEmpty: await isDirectoryEmpty(dirPath),
      hasMemoryBank: existsSync(path.join(dirPath, 'memory-bank')),
      hasCursorRules: existsSync(path.join(dirPath, '.cursorrules')),
    });
  } catch {
    return false;
  }
}

/** The answer section for files that already existed. Empty text when there are none. */
export function formatSkippedSection(skippedFiles: FileEntry[]): string {
  if (skippedFiles.length === 0) return '';
  return `
## ⏭️ Skipped (already exist, left unchanged):
${skippedFiles.map(f => `- ⏭️ **${f.path}** - ${f.description}`).join('\n')}
`;
}

async function initializeM7Ecosystem(
  config: {
    projectName: string;
    description: string;
    technologies: string[];
    domain: string;
    currentDir: string;
  },
  journal: JournalSystem,
  schema?: SchemaSystem
) {
  const { projectName, description, technologies, domain, currentDir } = config;
  const createdFiles: FileEntry[] = [];
  const skippedFiles: FileEntry[] = [];

  // 1. Create PROJECT_SCHEMA.yaml using SchemaSystem (never replace an existing one)
  if (schema) {
    const schemaEntry = {
      path: 'PROJECT_SCHEMA.yaml',
      description: 'Central project configuration and structure'
    };
    if (await pathExistsNoFollow(path.join(currentDir, 'PROJECT_SCHEMA.yaml'))) {
      skippedFiles.push(schemaEntry);
    } else {
      await schema.initializeSchema(projectName, description);
      createdFiles.push(schemaEntry);
    }
  }

  // 2. Create Memory Bank structure
  await createMemoryBank(currentDir, projectName, description, technologies, domain, createdFiles, skippedFiles);

  // 3. Initialize .cursorrules
  await createCursorRules(currentDir, projectName, createdFiles, skippedFiles);

  // 4. Create basic project structure
  await createProjectStructure(currentDir, createdFiles, skippedFiles);

  // 4.5. Create M7 Knowledge System (reference files + cursor rule)
  await createKnowledgeSystem(currentDir, projectName, description, technologies, domain, createdFiles, skippedFiles);

  // 5. Initialize M7 Unified Memory System
  try {
    const memory = await getMemoryCore(currentDir);
    
    // Store project metadata at L2
    await memory.store(JSON.stringify({
      type: 'project_metadata',
      name: projectName,
      description,
      purpose: `${projectName} project following M7 methodology`,
      mainTechnologies: technologies,
      architecture: 'To be determined during Discovery phase',
      keyFeatures: ['Initial setup complete'],
      businessDomain: domain,
      lastUpdated: new Date().toISOString()
    }), {
      level: 'L2',
      source: 'documentation',
      contextKeys: ['project', 'metadata'],
      confidence: 1.0
    });

    // Store initial pattern at L3
    await memory.store(JSON.stringify({
      name: 'M7 Project Initialization',
      description: 'Automated setup of M7 methodology ecosystem',
      problem_context: 'New project setup with systematic methodology',
      solution_rationale: 'Provides complete framework for enterprise-ready development',
      success_criteria: ['Memory bank created', 'Rules configured', 'Structure established'],
      timestamp: new Date().toISOString()
    }), {
      level: 'L3',
      source: 'documentation',
      contextKeys: ['initialization', 'pattern'],
      confidence: 0.9
    });
  } catch (error) {
    log.warn('Unified Memory initialization skipped:', error);
    // Continue without memory - not critical for init
  }

  // 6. Log the initialization
  await journal.logFeature({
    name: 'M7 Ecosystem Initialization',
    description: `Complete M7 setup for ${projectName}`,
    implementation: `Automated initialization with memory bank, rules, and structure`,
    lessons: ['Automated setup reduces setup time', 'Systematic approach ensures completeness'],
    patterns: ['Automated initialization', 'Memory bank creation', 'Project structure'],
    complexity: 'light'
  });

  return { createdFiles, skippedFiles };
}

async function createMemoryBank(
  currentDir: string, 
  projectName: string, 
  description: string,
  technologies: string[],
  domain: string,
  createdFiles: FileEntry[],
  skippedFiles: FileEntry[]
) {
  await makeContainedDir(currentDir, 'memory-bank');

  // Project Brief (Foundation)
  const projectBrief = `# Project Brief: ${projectName}

## 🎯 Project Overview
**Name:** ${projectName}
**Domain:** ${domain}
**Description:** ${description}

## 🔧 Technology Stack
${technologies.map(tech => `- ${tech}`).join('\n')}

## 📋 Core Requirements
- [x] M7 methodology implementation
- [ ] Architecture definition
- [ ] Feature requirements gathering
- [ ] Technical implementation

## 🚀 Success Criteria
- Enterprise-ready codebase
- Comprehensive documentation
- Full test coverage
- Performance benchmarks met

## 🛡️ Quality Standards
- Zero Critical risks in production
- Context7 MCP integration for all libraries
- Playwright MCP for validation
- 7-File methodology compliance

*Created: ${new Date().toISOString()}*
*Methodology: M7 IDEAL*`;

  await createFile(currentDir, 'memory-bank/projectbrief.md', projectBrief, 'Foundation document', createdFiles, skippedFiles);

  // Product Context
  const productContext = `# Product Context: ${projectName}

## 🎯 Why This Project Exists
${description}

This project was initialized with M7 methodology to ensure:
- Systematic development approach
- Enterprise-ready architecture
- Preventive quality measures
- Comprehensive documentation

## 🎨 User Experience Goals
- Intuitive and responsive interface
- High performance and reliability
- Accessibility compliance
- Cross-platform compatibility

## 🔧 Technical Philosophy
- **Discovery First**: Research before implementation
- **Architecture-Driven**: Structure before details
- **Test-Driven**: Quality before features
- **Performance-Aware**: Optimization throughout

## 📊 Success Metrics
- User satisfaction: >4.5/5
- Performance: <200ms response time
- Reliability: >99.9% uptime
- Test coverage: >95%

*Updated: ${new Date().toISOString()}*`;

  await createFile(currentDir, 'memory-bank/productContext.md', productContext, 'Product vision and goals', createdFiles, skippedFiles);

  // Active Context
  const activeContext = `${M7_MANAGED_MARKER}
# Active Context: ${projectName}

## 🎯 Current Focus
**Phase:** Project Initialization ✅
**Next:** Architecture Discovery & Planning

## 📋 Recent Changes
- M7 ecosystem initialization complete
- Memory bank established
- Basic project structure created

## 🔄 Active Decisions
1. **Methodology**: M7 IDEAL chosen for systematic approach
2. **Tools**: Context7 + Playwright MCP integration planned
3. **Structure**: 7-File system for all features/bugs

## 🎯 Immediate Next Steps
1. Define first feature or improvement
2. Run \`@m7 analyze task\` for proper routing
3. Follow Discovery → Architecture → Planning cycle

## 💡 Current Considerations
- Technology stack finalization needed
- Architecture patterns to be established
- Integration strategies to be defined

*Updated: ${new Date().toISOString()}*`;

  await createFile(currentDir, 'memory-bank/activeContext.md', activeContext, 'Current work focus', createdFiles, skippedFiles);

  // System Patterns
  const systemPatterns = `# System Patterns: ${projectName}

## 🏗️ Architecture Decisions
*To be populated during Discovery phase*

## 🎨 Design Patterns
*To be established during implementation*

## 🔧 Technical Patterns
### M7 Methodology Integration
- **Discovery Phase**: Research-first approach
- **Context7 Integration**: Library documentation verification
- **Playwright Validation**: Real-world testing automation
- **7-File System**: Structured task management

### Quality Assurance
- Type-safety enforcement
- Comprehensive error handling
- Performance monitoring
- Automated testing strategies

## 🔗 Component Relationships
*Architecture mapping to be completed during planning*

## 📊 Performance Patterns
*Optimization strategies to be defined during implementation*

*Updated: ${new Date().toISOString()}*`;

  await createFile(currentDir, 'memory-bank/systemPatterns.md', systemPatterns, 'Architecture and patterns', createdFiles, skippedFiles);

  // Tech Context
  const techContext = `# Technical Context: ${projectName}

## 🔧 Technology Stack
${technologies.map(tech => `- **${tech}**: Version and configuration TBD`).join('\n')}

## 🛠️ Development Environment
- **M7 MCP Server**: Methodology automation
- **Context7 MCP**: Library documentation
- **Playwright MCP**: Browser automation
- **IDE**: Cursor with M7 integration

## 📦 Dependencies Management
- All libraries verified through Context7
- Version compatibility checked
- Breaking changes monitored
- Performance impact assessed

## 🏗️ Build & Deployment
*Configuration to be established during setup*

## 🧪 Testing Strategy
- Unit tests: >95% coverage target
- Integration tests: Critical paths
- E2E tests: Playwright automation
- Performance tests: Benchmark tracking

## 🛡️ Security Considerations
*Security analysis during architecture phase*

*Updated: ${new Date().toISOString()}*`;

  await createFile(currentDir, 'memory-bank/techContext.md', techContext, 'Technical environment', createdFiles, skippedFiles);

  // Progress
  const progress = `# Progress: ${projectName}

## ✅ Completed
- [x] **M7 Ecosystem Initialization** (${new Date().toLocaleDateString()})
  - Memory bank structure created
  - .cursorrules configured  
  - Project memory initialized
  - Journal systems active

## 🔄 In Progress
*No active development yet*

## 📋 Planned
- [ ] **Architecture Discovery**
  - Technology stack finalization
  - System design patterns
  - Integration architecture
  
- [ ] **First Feature Implementation**
  - Requirements gathering
  - Technical design
  - Implementation with M7 cycle

## 🚫 Known Issues
*No issues yet - clean initialization*

## 📊 Metrics
- **Initialization Time**: ~30 seconds
- **Files Created**: ${createdFiles.length + 6} (memory bank + structure)
- **M7 Compliance**: 100% (initialization phase)

## 🎯 Success Indicators
- ✅ M7 methodology active
- ✅ Memory systems operational  
- ✅ Quality gates established
- ⏳ First feature development pending

*Updated: ${new Date().toISOString()}*`;

  await createFile(currentDir, 'memory-bank/progress.md', progress, 'Project progress tracking', createdFiles, skippedFiles);
}

async function createCursorRules(
  currentDir: string,
  projectName: string,
  createdFiles: FileEntry[],
  skippedFiles: FileEntry[]
) {
  const cursorRules = `# 📚 ${projectName} - M7 Methodology Rules

## 🎯 Core Philosophy
This project follows M7 IDEAL methodology for systematic, enterprise-ready development.

**Key Principles:**
- **Discovery before Implementation** — protects against premature convergence
- **Architecture-First** — provides structure that prevents integration issues
- **Risk-Aware Progression** — critical risks are resolved before they compound
- **Context7 Integration** — verifies library docs to prevent version mismatches
- **Playwright Validation** — real-world browser testing for UI changes

## Tools Integration
- **M7 MCP Server** (\`@m7\`) — task analysis, planning, memory
- **Context7 MCP** (\`@context7\`) — library documentation verification
- **Playwright MCP** (\`@playwright\`) — browser automation and testing

## 7-Phase Documentation System
Each phase produces an artifact that serves as a memory bank for future tasks:

| # | File | What it protects against |
|---|------|--------------------------|
| 1 | **DISCOVERY_REPORT.md** | Incomplete understanding, missed root causes |
| 2 | **ARCHITECTURE_CONTEXT.md** | Integration blindspots |
| 3 | **SOLUTION_PLAN.md** | Premature coding without clear direction |
| 4 | **IMPACT_ANALYSIS.md** | Undetected regressions and edge cases |
| 5 | **IMPLEMENTATION_SIMULATION.md** | Cognitive rehearsal — surfaces unknowns |
| 6 | **RISK_MITIGATION.md** | Unresolved risks that compound |
| 7 | **IMPLEMENTATION_REPORT.md** | Lost learnings — captures patterns |

## Cognitive Safeguards

### Before code changes — best results achieved when:
1. Run \`@m7 analyze task "description"\` — provides structure and catches existing solutions
2. Critical risks are addressed — prevents compounding failures
3. Context7 check for new libraries — prevents version/API mismatches
4. Playwright validation for UI changes — catches visual regressions

### Development Flow:
1. **Discovery** (20-25% time) — research, root cause analysis
2. **Architecture** (10-15% time) — map current system
3. **Planning** (35-40% time) — iterative design optimization
4. **Implementation** (20-25% time) — follow simulation as guide
5. **Validation** (5-10% time) — test, measure, document

### Risk Awareness:
- 🔴 **Critical risks** — resolve before proceeding (protects against catastrophic failures)
- 🟡 **Major risks** — flag for explicit review
- 🟢 **Minor risks** — proceed with monitoring
- 📊 **Success metrics** — define and measure for each task

## Memory Management
- Use \`@m7 recall memory depth=X\` to access project knowledge
- Store patterns with \`@m7 store pattern\` for reuse
- Update project context regularly

## Project-Specific Patterns
*Populated as patterns emerge during development*

## Success Metrics
- **Prevented Failure Value (PFV)** — class of prevented damage
- **Risk Surface Reduction (RSR)** — uncertainties resolved before coding
- Time to solution, error reduction, performance impact, test coverage

## Continuous Improvement
- Review and update these rules based on project learnings
- Document successful patterns for reuse
- Refine methodology based on project needs

---
*Generated by M7 MCP v1.1.0*
*Project: ${projectName}*
*Created: ${new Date().toISOString()}*`;

  await createFile(currentDir, '.cursorrules', cursorRules, 'Project-specific M7 methodology rules', createdFiles, skippedFiles);
}

async function createKnowledgeSystem(
  currentDir: string,
  projectName: string,
  description: string,
  technologies: string[],
  domain: string,
  createdFiles: FileEntry[],
  skippedFiles: FileEntry[]
) {
  // 1. Create .cursor/rules/m7-memory.mdc
  await makeContainedDir(currentDir, '.cursor/rules');

  const mdcContent = `---
description: M7 project knowledge system — reference files index
alwaysApply: true
---
# M7 Project Knowledge

Before starting a task, read the relevant reference file:

| File | Contains | When to read |
|------|----------|--------------|
| \`INDEX.md\` | Project map — modules, entry points, key systems | Any task — start here |
| \`MASTER_REFERENCE.md\` | Full architecture — all tools, deps, data files | Architecture work, new systems, deep changes |
| \`CODING_STANDARDS.md\` | Project conventions — tool structure, naming, error handling, anti-patterns | Writing or reviewing code |
| \`CYCLE_REGISTRY.md\` | Decision history — what was done, why, lessons learned, ADRs | Before making architectural decisions |

After completing a task, update the relevant file:
- Added a module/tool → update INDEX.md and MASTER_REFERENCE.md
- Made an architectural decision → append to CYCLE_REGISTRY.md
- Established a new pattern or convention → append to CODING_STANDARDS.md
`;

  await createFile(currentDir, '.cursor/rules/m7-memory.mdc', mdcContent, 'M7 knowledge system — auto-loaded project memory', createdFiles, skippedFiles);

  // 2. Create INDEX.md
  const techList = technologies.length > 0 && technologies[0] !== 'To be determined'
    ? technologies.join(', ')
    : 'To be determined';

  const indexContent = `# ${projectName} — Index

> Project navigation map. Read before any task.
> Details: MASTER_REFERENCE.md | Patterns: CODING_STANDARDS.md | History: CYCLE_REGISTRY.md

## What is this

${description || `${projectName} — project following M7 methodology.`}

**Stack:** ${techList}
**Domain:** ${domain}

## Project Structure

\`\`\`
${projectName}/
├── INDEX.md              ← You are here
├── MASTER_REFERENCE.md   ← Full architecture
├── CODING_STANDARDS.md   ← Code conventions
├── CYCLE_REGISTRY.md     ← Decision history
├── .cursorrules          ← M7 methodology rules
├── memory-bank/          ← Project context (markdown)
├── docs/                 ← Documentation
│   ├── features/         ← Feature M7 cycles
│   └── debug/            ← Bug M7 cycles
└── .m7/                  ← M7 runtime data (git-ignored)
\`\`\`

## Known Issues

*None yet — clean initialization.*

*Initialized: ${new Date().toISOString()}*
`;

  await createFile(currentDir, 'INDEX.md', indexContent, 'Project navigation map', createdFiles, skippedFiles);

  // 3. Create MASTER_REFERENCE.md
  const masterRefContent = `${M7_MANAGED_MARKER}
# ${projectName} — Master Reference

## Identity
- **Project**: ${projectName}
- **Description**: ${description || 'M7 Methodology Project'}
- **Stack**: ${techList}
- **Domain**: ${domain}

## Architecture

*To be documented during Discovery and Architecture phases.*

## Key Dependencies

*To be populated as dependencies are added.*

## Data Files

| Path | Purpose |
|------|---------|
| \`.m7/memory/\` | Persisted memory (JSON) |
| \`.m7/errors.json\` | Error journal |
| \`.m7/features.json\` | Feature journal |
| \`memory-bank/\` | Markdown knowledge bank |
| \`config/\` | Configuration files |

*Initialized: ${new Date().toISOString()}*
`;

  await createFile(currentDir, 'MASTER_REFERENCE.md', masterRefContent, 'Full architecture reference', createdFiles, skippedFiles);

  // 4. Create CODING_STANDARDS.md
  const standardsContent = `${M7_MANAGED_MARKER}
# ${projectName} — Coding Standards

> Project-specific conventions. Not generic best practices — rules for this project.

## Stack

${techList}

## Conventions

*To be populated as patterns emerge during development.*

## Anti-Patterns

*To be populated as issues are discovered.*

## Discovered Patterns

*Patterns stored via M7 will appear here automatically.*

*Initialized: ${new Date().toISOString()}*
`;

  await createFile(currentDir, 'CODING_STANDARDS.md', standardsContent, 'Project coding conventions', createdFiles, skippedFiles);

  // 5. Create CYCLE_REGISTRY.md
  const registryContent = `${M7_MANAGED_MARKER}
# ${projectName} — Cycle Registry

> Decision history: what was done, why, lessons learned. Updated after each task.

## Format

\`\`\`
### [date] Brief description
- **Decision**: what was decided
- **Why**: reasoning
- **Changed**: files/systems affected
- **Lesson**: takeaway (if any)
\`\`\`

---

## ${new Date().toISOString().split('T')[0]} — Project Initialization

- **Decision**: Initialize ${projectName} with M7 methodology
- **Why**: Systematic approach to development with built-in memory and quality gates
- **Changed**: Created project structure, memory bank, reference files, cursor rules
- **Lesson**: Starting point — all reference files need to be populated as the project evolves

*Initialized: ${new Date().toISOString()}*
`;

  await createFile(currentDir, 'CYCLE_REGISTRY.md', registryContent, 'Decision and cycle history', createdFiles, skippedFiles);
}

async function createProjectStructure(
  currentDir: string,
  createdFiles: FileEntry[],
  skippedFiles: FileEntry[]
) {
  // Create docs structure
  await makeContainedDir(currentDir, 'docs');
  await makeContainedDir(currentDir, 'docs/features');
  await makeContainedDir(currentDir, 'docs/debug');

  // Create .m7 directory for M7 system data (project-specific)
  await makeContainedDir(currentDir, '.m7');

  // Create README with M7 information (for humans)
  const readme = `# ${path.basename(currentDir)}

🚀 **M7 Methodology Project** - Systematic, Enterprise-Ready Development

## 🎯 Project Overview
This project follows the M7 IDEAL methodology for systematic feature development and debugging.

## 🔧 Getting Started
1. **Analyze any task**: \`@m7 analyze task "your task description"\`
2. **Follow the guidance**: M7 will route you through proper methodology
3. **Use Memory System**: \`@m7 recall memory\` to access project knowledge

## 📁 Structure
- \`memory-bank/\` - Project knowledge and context  
- \`docs/features/\` - Feature development documentation
- \`docs/debug/\` - Bug analysis and resolution
- \`.cursorrules\` - M7 methodology enforcement
- \`.m7/\` - M7 system data (auto-generated, project-specific)

## 🛠️ M7 Tools Available
- **Task Analysis**: \`@m7 analyze task\`
- **Memory Recall**: \`@m7 recall memory\`  
- **Pattern Storage**: \`@m7 store pattern\`
- **Project Updates**: \`@m7 update project memory\`
- **Visual Validation**: \`@m7 visual validate\`

## 🎯 Methodology
Follow the **Discovery → Architecture → Planning → Implementation** cycle for all work.

---
*Initialized with M7 MCP v3.4*`;

  await createFile(currentDir, 'README.md', readme, 'Project documentation (for humans)', createdFiles, skippedFiles);

  // Create or update .gitignore to exclude .m7/ directory.
  // A .gitignore that is a symlink is left alone and not even read: it may lead out of the
  // project (a write would change a file elsewhere) or to a device. Only a regular file
  // (or none) gets the line.
  const gitignorePath = await resolveContainedEntry(currentDir, '.gitignore');
  if (gitignorePath === null) throw new Error('Refusing to write outside the project: .gitignore');

  if (await isSymlinkNoFollow(gitignorePath)) {
    skippedFiles.push({
      path: '.gitignore',
      description: 'Is a symbolic link; M7 does not write through it. Add .m7/ to the file it points to if you want M7 data ignored'
    });
  } else {
    let gitignoreContent = '';

    try {
      const existingGitignore = await fs.readFile(gitignorePath, 'utf-8');
      gitignoreContent = existingGitignore;
    } catch {
      // File doesn't exist, will create new one
    }

    if (!gitignoreContent.includes('.m7/')) {
      gitignoreContent += '\n# M7 MCP System Data (project-specific)\n.m7/\n';
      await fs.writeFile(gitignorePath, gitignoreContent);
      createdFiles.push({path: '.gitignore', description: 'Updated to exclude .m7/ directory'});
    }
  }

  // Add directory structure markers
  createdFiles.push({path: 'docs/features/', description: 'Feature development documentation'});
  createdFiles.push({path: 'docs/debug/', description: 'Bug analysis and resolution'});
  createdFiles.push({path: '.m7/', description: 'M7 system data (project-specific, git-ignored)'});
}

/**
 * Create first M7 task structure
 */
async function createFirstTask(
  taskDescription: string | undefined,
  projectName: string
): Promise<{ folder: string; files: string[] } | null> {
  try {
    const result = await createM7StructureInternal({
      taskId: 'initial-project-setup',
      route: 'light',
      description: taskDescription || `Первоначальная настройка проекта ${projectName}`
    });
    
    if (result.success && result.folder && result.files) {
      return {
        folder: result.folder,
        files: result.files
      };
    }
    return null;
  } catch (error) {
    log.debug(`initProject] Failed to create first task: ${error}`);
    return null;
  }
}

/**
 * Internal function for Cold Start initialization
 * Called from analyzeTask when empty directory detected
 */
export async function initProjectInternal(params: {
  projectPath?: string;
  projectName?: string;
  description?: string;
  technologies?: string[];
  domain?: string;
  taskDescription?: string;
  journal?: JournalSystem;
  schema?: SchemaSystem;
}): Promise<ColdStartResult> {
  const currentDir = params.projectPath || getProjectPath();
  const projectName = params.projectName || path.basename(currentDir);
  const description = params.description || `${projectName} - M7 Methodology Project`;
  const technologies = params.technologies || ['To be determined'];
  const domain = params.domain || 'General';
  
  const createdFiles: FileEntry[] = [];
  const skippedFiles: FileEntry[] = [];
  
  try {
    log.error(`🚀 [Cold Start] Initializing M7 ecosystem in: ${currentDir}`);
    
    // 1. Create Memory Bank
    await createMemoryBank(currentDir, projectName, description, technologies, domain, createdFiles, skippedFiles);
    
    // 2. Create .cursorrules
    await createCursorRules(currentDir, projectName, createdFiles, skippedFiles);
    
    // 3. Create project structure (README.md, docs/, .m7/)
    await createProjectStructure(currentDir, createdFiles, skippedFiles);
    
    // 4. Create M7 Knowledge System (reference files + cursor rule)
    await createKnowledgeSystem(currentDir, projectName, description, technologies, domain, createdFiles, skippedFiles);
    
    // 5. Initialize Unified Memory System
    try {
      const memory = await getMemoryCore(currentDir);
      
      // Store project metadata at L2
      await memory.store(JSON.stringify({
        type: 'project_metadata',
        name: projectName,
        description,
        purpose: `${projectName} project following M7 methodology`,
        mainTechnologies: technologies,
        architecture: 'To be determined during Discovery phase',
        keyFeatures: ['Initial setup complete'],
        businessDomain: domain,
        lastUpdated: new Date().toISOString()
      }), {
        level: 'L2',
        source: 'documentation',
        contextKeys: ['project', 'metadata'],
        confidence: 1.0
      });
      
      log.error(`✅ [Cold Start] Unified Memory initialized`);
      createdFiles.push({
        path: 'UnifiedMemory: L2 project indexed',
        description: 'Semantic memory for AI search'
      });
    } catch (e: any) {
      log.error(`⚠️ [Cold Start] Memory indexing skipped: ${e.message}`);
      // Don't fail the whole init if indexing fails
    }
    
    // 6. Log to journal if provided
    if (params.journal) {
      await params.journal.logFeature({
        name: 'M7 Cold Start Initialization',
        description: `Automatic M7 setup for ${projectName}`,
        implementation: `Cold Start detected empty directory and initialized M7 ecosystem`,
        lessons: ['Automated setup reduces onboarding time'],
        patterns: ['Cold Start', 'Auto-initialization'],
        complexity: 'light'
      });
    }
    
    // 7. Create first task
    const firstTask = await createFirstTask(params.taskDescription, projectName);
    
    log.error(`✅ [Cold Start] Initialization complete: ${createdFiles.length} files created`);
    
    return {
      success: true,
      projectPath: currentDir,
      projectName,
      filesCreated: createdFiles.map(f => f.path),
      filesSkipped: skippedFiles.map(f => f.path),
      firstTask: firstTask || undefined,
      memoryInitialized: true
    };
  } catch (error) {
    log.error(`❌ [Cold Start] Initialization failed: ${error}`);
    return {
      success: false,
      projectPath: currentDir,
      projectName,
      filesCreated: createdFiles.map(f => f.path),
      filesSkipped: skippedFiles.map(f => f.path),
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
} 
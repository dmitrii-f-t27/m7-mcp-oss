import { z } from 'zod';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { cwd } from 'process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { getProjectPath, ensureProjectPathResolved } from '../utils/projectPath.js';
import { createLogger } from '../utils/logger.js';
import { writeIfAbsent } from '../utils/safeWrite.js';
import { resolveContained } from '../security/pathGuard.js';

const logger = createLogger('createStructure');

interface M7File {
  path: string;
  description: string;
  template: string;
}
import { 
  generateInteractiveDiscovery, 
  generateInteractiveArchitecture, 
  generateInteractiveSolutionPlan,
  TemplateContext 
} from '../templates/interactiveTemplates.js';

const CreateStructureRequestSchema = z.object({
  task_id: z.string(),
  route: z.enum(['light', 'medium', 'heavy']),
  description: z.string().optional(),
  version: z.string().optional(),
  status: z.string().optional(),
});

// v5.0: Tool registration removed, but file kept for createM7StructureInternal()
// The tool was deprecated in favor of mcp_m7_cycle
export const createStructureTool = {
  name: 'mcp_m7_create_structure',
  description: '[DEPRECATED v5.0] Use mcp_m7_cycle instead. Create M7 file structure for a task',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Unique identifier for the task'
      },
      route: {
        type: 'string',
        enum: ['light', 'medium', 'heavy'],
        description: 'Task complexity route'
      },
      description: {
        type: 'string',
        description: 'Human-readable description of the task (optional)'
      },
      version: {
        type: 'string',
        description: 'Version identifier (optional, e.g. "1.0", "v2.1")'
      },
      status: {
        type: 'string',
        description: 'Current status (optional, e.g. "in-progress", "completed")'
      }
    },
    required: ['task_id', 'route']
  },
  handler: async (request: any, server?: unknown) => {
    const params = CreateStructureRequestSchema.parse(request);
    const { task_id, route, description, version, status } = params;

    try {
      const projectRoot = await ensureProjectPathResolved(server);
      // Generate semantic folder name
      const semanticFolder = generateSemanticFolderName(task_id, description, version, status);
      
      const files = generateM7Files(task_id, route, semanticFolder);
      
      // Actually create the files on disk; a file that already exists is kept
      const { skipped } = await createM7Files(files, projectRoot);
      
      return {
        content: [{
          type: 'text',
          text: `# M7 Structure Created Successfully

## Task: ${task_id}
**Route:** ${route.toUpperCase()}
**Folder:** ${semanticFolder}
${description ? `**Description:** ${description}` : ''}
${version ? `**Version:** ${version}` : ''}
${status ? `**Status:** ${status}` : ''}

## Files:
${files.map(f => skipped.includes(f.path)
  ? `- ⏭️ **${f.path}** - kept, already exists`
  : `- ✅ **${f.path}** - ${f.description}`).join('\n')}

${skipped.length > 0
  ? `⏭️ **${skipped.length} existing file(s) kept. Nothing was overwritten.**`
  : '💾 **Files physically created on disk!**'}

## Next Steps:
1. Start with **DISCOVERY_REPORT.md** - research existing solutions and best practices
2. Follow the M7 iterative cycle
3. Use Context7 MCP for library documentation
4. Use Playwright MCP for browser validation

## M7 Methodology Reminder:
- 🔍 Discovery first (20-25% of time)
- 🏗️ Architecture analysis (10-15% of time) 
- 📋 Planning & optimization (35-40% of time)
- ⚡ Implementation (20-25% of time)
- ✅ Validation (5-10% of time)

Ready to begin M7 cycle! 🚀`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Error creating M7 structure:** ${error instanceof Error ? error.message : 'Unknown error'}`
        }],
        isError: true
      };
    }
  }
};

// Helper function to create URL-friendly slug from text
function slugify(text: string, maxLength: number = 30): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\u0040-\u1FFF\u2C00-\uD7FF\w\s-]/g, '') // Keep Latin, Cyrillic, spaces, hyphens
    .replace(/\s+/g, '-')     // Replace spaces with hyphens
    .replace(/--+/g, '-')     // Replace multiple hyphens with single
    .slice(0, maxLength)      // Limit length
    .replace(/^-+|-+$/g, ''); // Trim leading/trailing hyphens
}

// Generate semantic folder name from task components
function generateSemanticFolderName(
  taskId: string,
  description?: string,
  version?: string,
  status?: string
): string {
  let parts = [taskId];
  
  if (description && description.trim()) {
    const slug = slugify(description);
    if (slug.length > 0) {
      parts.push(slug);
    }
  }
  
  if (version && version.trim()) {
    // Ensure version starts with 'v' if not already
    const versionStr = version.startsWith('v') ? version : `v${version}`;
    parts.push(versionStr);
  }
  
  if (status && status.trim()) {
    parts.push(status);
  }
  
  return parts.join('_');
}

// Function to actually create files on disk.
// A file that already exists is never replaced: it may hold the user's edits.
// Every path is checked first, before any directory is made: a task id with `..`
// or a docs folder that is a symlink must not lead out of the project (`wx` stops
// a replace, but it does not protect the parent directories).
// Returns the project-relative paths created and the ones kept.
async function createM7Files(
  files: M7File[],
  projectRoot?: string
): Promise<{ created: string[]; skipped: string[] }> {
  const resolvedRoot = projectRoot || getProjectPath();
  logger.debug(`Using project path: ${resolvedRoot}`);

  const created: string[] = [];
  const skipped: string[] = [];

  const targets: Array<{ file: M7File; absolutePath: string }> = [];
  for (const file of files) {
    const absolutePath = await resolveContained(resolvedRoot, file.path);
    if (absolutePath === null) {
      throw new Error(`Refusing to write outside the project: ${file.path}`);
    }
    targets.push({ file, absolutePath });
  }

  for (const { file, absolutePath } of targets) {
    try {
      // Create directory recursively if it doesn't exist
      await mkdir(dirname(absolutePath), { recursive: true });

      // Write file content only when the file is absent
      const outcome = await writeIfAbsent(absolutePath, file.template);
      if (outcome === 'created') {
        created.push(file.path);
        logger.info(`Created: ${absolutePath}`);
      } else {
        skipped.push(file.path);
        logger.info(`Kept existing file: ${absolutePath}`);
      }
    } catch (error) {
      logger.error(`Failed to create ${file.path}:`, error);
      throw error;
    }
  }

  return { created, skipped };
}

// The folder of one task, relative to the project root, with forward slashes.
function taskFolderPath(route: string, folderName: string): string {
  const baseDir = route === 'light' ? 'docs/features' : 'docs/debug';
  return `${baseDir}/${folderName}`;
}

function generateM7Files(taskId: string, route: string, folderName?: string) {
  const taskDir = taskFolderPath(route, folderName || taskId);

  // Parse task context from taskId for smarter templates
  const context: TemplateContext = {
    taskId,
    taskDescription: taskId.replace(/-/g, ' '),
    route: route as 'light' | 'medium' | 'heavy',
    originalRequest: taskId.replace(/-/g, ' ') // Will be replaced with actual request when available
  };

  return [
    {
      path: `${taskDir}/DISCOVERY_REPORT.md`,
      description: 'Research and exploration phase',
      template: generateInteractiveDiscovery(context)
    },
    {
      path: `${taskDir}/ARCHITECTURE_CONTEXT.md`,
      description: 'Current system analysis',
      template: generateInteractiveArchitecture(context)
    },
    {
      path: `${taskDir}/SOLUTION_PLAN.md`,
      description: 'Detailed implementation plan (versioned)',
      template: generateInteractiveSolutionPlan(context)
    },
    {
      path: `${taskDir}/IMPACT_ANALYSIS.md`,
      description: 'Risk and impact assessment (versioned)',
      template: generateInteractiveImpactAnalysis(context)
    },
    {
      path: `${taskDir}/IMPLEMENTATION_SIMULATION.md`,
      description: 'Code simulation and edge cases',
      template: generateImplementationSimulation(context)
    },
    {
      path: `${taskDir}/RISK_MITIGATION.md`,
      description: 'Risk resolution strategies',
      template: `# Risk Mitigation: ${taskId}

## 🚨 Critical Risks & Mitigations

Based on your analysis, what are the REAL risks?

### Risk 1: [Most Likely to Happen]
**What**: _____________
**Probability**: ___% 
**Impact**: _____________
**Early Warning Signs**: _____________

**Mitigation Strategy**:
- Preventive action: _____________
- Detection method: _____________
- Recovery plan: _____________

### Risk 2: [Most Damaging if Happens]
**What**: _____________
**Why it matters**: _____________

**Mitigation Strategy**:
- How to avoid: _____________
- How to minimize impact: _____________
- Rollback approach: _____________

## 🛡️ Safety Checklist

Before implementation:
- [ ] All critical risks have mitigations
- [ ] Rollback plan tested mentally
- [ ] Monitoring in place for early warning
- [ ] Team aware of risks

## 📊 Risk Tracking

| Risk | Status | Mitigation Applied | Outcome |
|------|--------|-------------------|---------|
| _____| ⏳ Monitoring | Not yet | TBD |`
    },
    {
      path: `${taskDir}/IMPLEMENTATION_REPORT.md`,
      description: 'Post-implementation summary',
      template: `# Implementation Report: ${taskId}

## 📝 Summary
**Status**: [ ] Planning | [ ] In Progress | [ ] Completed
**Actual vs Planned**: _____________

## 📊 What Actually Happened

### Did we extend or create new?
Choice: _____________
Result: _____________

### Time Analysis:
- Planned: _____________
- Actual: _____________
- Difference because: _____________

## 🎯 Outcomes

### What worked well:
- 
- 

### What was harder than expected:
- 
- 

### What we learned:
- 
- 

## 📈 Metrics
- Lines changed: _____________
- Files affected: _____________
- Tests added: _____________
- Performance impact: _____________

## 🔄 For Next Time
**Pattern to remember**: _____________
**Mistake to avoid**: _____________

*Report generated: ${new Date().toISOString()}*`
    }
  ];
}

// Helper function for interactive Impact Analysis
function generateInteractiveImpactAnalysis(context: TemplateContext): string {
  const { taskId, taskDescription, route } = context;
  
  return `# 📊 Impact Analysis: Understanding the Ripple Effects

## 🎯 Change Scope

### What's changing:
**Direct changes**: _____________
**Indirect effects**: _____________
**Who needs to know**: _____________

## 🌊 Ripple Effect Analysis

### Level 1: Direct Impact (Immediate)
- Components modified: _____________
- APIs affected: _____________
- Database changes: _____________

### Level 2: Integration Impact (Next layer)
- Consuming components: _____________
- Dependent services: _____________
- UI elements affected: _____________

### Level 3: System Impact (Whole picture)
- Performance implications: _____________
- Security considerations: _____________
- User experience changes: _____________

## 🚦 Go/No-Go Decision Framework

### Green Light Criteria ✅
- [ ] All impacts identified and acceptable
- [ ] Rollback plan exists and tested
- [ ] Stakeholders informed and aligned
- [ ] Monitoring ready for changes

### Yellow Light (Proceed with Caution) 🟡
- [ ] Some uncertainty remains but manageable
- [ ] Additional testing required
- [ ] Phased rollout recommended

### Red Light (Stop and Reconsider) 🔴
- [ ] Critical system at risk
- [ ] Unclear impact scope
- [ ] No rollback strategy
- [ ] Major performance degradation likely

## 📊 Cost-Benefit Analysis

### Benefits:
1. **Primary**: _____________
2. **Secondary**: _____________
3. **Long-term**: _____________

### Costs:
1. **Development time**: _____________
2. **Testing overhead**: _____________
3. **Maintenance burden**: _____________

### ROI Assessment:
**Worth it?** YES / NO because _____________`;
}

// Helper function for Implementation Simulation
function generateImplementationSimulation(context: TemplateContext): string {
  return `# 🎮 Implementation Simulation: Dry Run Before Real Run

## 🧪 Let's Simulate the Implementation

### Step 1: What happens first?
**I will**: _____________
**System will**: _____________
**Potential issue**: _____________

### Step 2: Core implementation
**Key code change**: 
\`\`\`typescript
// Pseudocode or actual code
_____________
\`\`\`
**This affects**: _____________

### Step 3: Integration point
**Connecting to**: _____________
**Method**: _____________
**Edge case**: _____________

## 🎲 What Could Go Wrong?

### Scenario 1: Happy Path
- User does: _____________
- System responds: _____________
- Result: ✅ Success

### Scenario 2: Common Error
- User does: _____________
- System fails at: _____________
- Recovery: _____________

### Scenario 3: Edge Case
- Unusual input: _____________
- System behavior: _____________
- Handling: _____________

## 🔍 Pre-Implementation Checklist

Technical readiness:
- [ ] All dependencies available
- [ ] Test environment ready
- [ ] Rollback plan clear
- [ ] Monitoring prepared

Mental readiness:
- [ ] I understand the requirement
- [ ] I know what success looks like
- [ ] I have a plan B
- [ ] I know when to ask for help

## 🎯 Success Criteria
**Implementation succeeds when**: _____________
**First sign of success**: _____________
**Final validation**: _____________`;
}

// v5.0: Internal function for programmatic structure creation
// Used by analyzeTask.ts and initProject.ts
export interface CreateStructureResult {
  success: boolean;
  /** The folder name, for display (`<id>_<slug>`). */
  folder?: string;
  /** The task folder as a project-relative path with forward slashes (`docs/debug/<name>`). */
  relFolder?: string;
  /** Every path of the task folder, created or kept. */
  files?: string[];
  /** The paths in `files` that already existed and were left unchanged. */
  skipped?: string[];
  error?: string;
}

export interface CreateStructureParams {
  taskId: string;
  route: 'light' | 'medium' | 'heavy';
  description?: string;
}

export async function createM7StructureInternal(
  params: CreateStructureParams,
  server?: unknown
): Promise<CreateStructureResult> {
  try {
    const { taskId, route, description } = params;
    const projectRoot = await ensureProjectPathResolved(server);
    
    // Generate semantic folder name
    const semanticFolder = generateSemanticFolderName(taskId, description);
    
    // Generate M7 files
    const files = generateM7Files(taskId, route, semanticFolder);
    
    // Create files on disk (existing files are kept)
    const { skipped } = await createM7Files(files, projectRoot);
    
    return {
      success: true,
      folder: semanticFolder,
      relFolder: taskFolderPath(route, semanticFolder),
      files: files.map(f => f.path),
      skipped
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
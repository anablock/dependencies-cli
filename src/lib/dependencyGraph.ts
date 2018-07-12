// TODO: Merge dependencyGraph and componentGraph
import { Tooling } from 'jsforce';
import {Node, QuickAction , Edge, ScalarNode, CustomField, ValidationRule, CustomObject, FieldDefinition, MetadataComponentDependency, ComponentNode} from './NodeDefs';
import {AbstractGraph} from './abstractGraph';
import {FindAllDependencies} from './DFSLib';

export const componentsWithParents = ['CustomField', 'ValidationRule', 'QuickAction'];

export class DependencyGraph extends AbstractGraph{
  public nodesMap: Map<string, Node> = new Map<string, Node>();
  public edges: Set<Edge> = new Set<Edge>();

  private tooling: Tooling;
  private allComponentIds: string[];
  private customFields: CustomField[];
  private validationRules: ValidationRule[];
  private customObjects: CustomObject[];
  private customFieldDefinitions: FieldDefinition[];
  private quickActions: QuickAction[];

  constructor(tool: Tooling) {
      super();
      this.tooling = tool;
   }

  public get nodes() {
      return this.nodesMap.values();
  }

  public async init() {
    this.allComponentIds = await this.retrieveAllComponentIds();
    this.customFields = await this.retrieveCustomFields(this.allComponentIds);
    this.validationRules = await this.retrieveValidationRules(this.allComponentIds);
    this.quickActions = await this.retrieveQuickActions(this.allComponentIds);
    this.customObjects = await this.retrieveCustomObjects(this.getObjectIds());
    const customFieldEntities = this.customFields.map(r => r.TableEnumOrId);
    this.customFieldDefinitions = await this.retrieveLookupRelationships(customFieldEntities);
    const lookupRelationships = this.customFieldDefinitions.filter(x => x.DataType.startsWith('Lookup'));
    lookupRelationships.forEach(element => {
      element.DataType = element.DataType.slice(element.DataType.indexOf('(') + 1, element.DataType.lastIndexOf(')'));
    });
  }

  public buildGraph(records: MetadataComponentDependency[]) {
    // Reset edges and nodes
    this.nodesMap = new Map<string, Node>();
    this.edges = new Set<Edge>();
    const parentRecords = this.getParentRecords();

    for (const record of records) {
      let parentName = '';
      let refParentName = '';
      
      if (record.RefMetadataComponentName.startsWith('0')) {
        continue;
      }

      if (componentsWithParents.indexOf(record.MetadataComponentType) >= 0) {
        parentName = parentRecords.get(record.MetadataComponentId) + '.';
      }

      if (componentsWithParents.indexOf(record.RefMetadataComponentType) >= 0) {
        refParentName = parentRecords.get(record.RefMetadataComponentId) + '.';
      }

      const srcId: string = record.MetadataComponentId;
      const srcName = record.MetadataComponentName;
      const srcType = record.MetadataComponentType;

      const dstId: string = record.RefMetadataComponentId;
      const dstName = record.RefMetadataComponentName
      const dstType = record.RefMetadataComponentType;

      const srcDetails = new Map<string, object>();
      srcDetails.set('name', (srcName as String));
      srcDetails.set('type', (srcType as String));
      srcDetails.set('parent', (parentName as String))
      const srcNode: Node = this.getOrAddNode(srcId, srcDetails);

      const dstDetails = new Map<string, object>();
      dstDetails.set('name', (dstName as String));
      dstDetails.set('type', (dstType as String));
      dstDetails.set('parent', (refParentName as String))
      const dstNode: Node = this.getOrAddNode(dstId, dstDetails);

      this.edges.add({ from: record.MetadataComponentId, to: record.RefMetadataComponentId });
      this.addEdge(srcNode, dstNode);

      if (record.MetadataComponentType === 'AuraDefinition' && record.RefMetadataComponentType === 'AuraDefinitionBundle') {
        this.edges.add({ from: record.RefMetadataComponentId, to: record.MetadataComponentId }); // Also add reverse reference
        this.addEdge(dstNode, srcNode);
        }

    }
    this.addFieldRelationships();
  }

  public runDFS(initialNodes: Node[]) {
      const dfs = new FindAllDependencies(this);
      initialNodes.forEach(node => {
          let graphNode = this.getOrAddNode(node.name,node.details); //Grab node from this graph
          dfs.runNode(graphNode);
      });


      this.nodesMap = dfs.visited;
      this.edges = dfs.visitedEdges;

  } 

  public getOrAddNode(name: string, details: Map<string, object>): Node {
    let n: Node = this.nodesMap.get(name);
    if (n) {
        return n;   
    }

    n = new ScalarNode(name, details);
    this.nodesMap.set(name, n);
    return n;
}

public addEdge(src: Node, dst: Node): void {
    (src as ScalarNode).addEdge(dst);
}

public getEdges(src: Node): IterableIterator<Node> {
    return (src as ScalarNode).getEdges();
}
public getNodeFromName(name: string): Node {
    let found: Node;
    Array.from(this.nodes).forEach(node => {
        if ((node.details.get('name') as String).startsWith(name) && (node.details.get('type') as String) === 'CustomObject') {
            found = node; // Returning node here does not work and I don't know why
        }
    });
    return found;
}

public getNodeShortId(name: string): Node {
    let found: Node;
    Array.from(this.nodes).forEach(node => {
        if (node.name.startsWith(name)) {
            found = node; // Returning node here does not work and I don't know why
        }
    });
    return found;
}

public addFieldRelationships() {
    this.customFieldDefinitions.forEach(fielddef => {
        const n1 = this.getNodeShortId(fielddef.EntityDefinitionId);
        const objName = fielddef.DataType.slice(fielddef.DataType.indexOf('(') + 1, fielddef.DataType.lastIndexOf(')'));
        const n2: Node = this.getNodeFromName(objName);
        if (n1 != null && n2 != null) {
            this.addEdge(n1, n2);
        }
    });
}

  /**
   * Render as DOT format
   */
  public toDotFormat(): string {

    // TODO Depending on the size of orgs, you may not want to
    // keep all this in memory. However, you don't want to do
    // console.log in library code, and this method really belongs
    // on the graph. Instead of using ux.log on every
    // line, just return a stream that you continue to write to,
    // then the command can call ux.log from the stream events.

    let dot = 'digraph graphname {\n';
    dot += '  rankdir=RL;\n';
    dot += '  node[shape=Mrecord, bgcolor=black, fillcolor=lightblue, style=filled];\n';
    dot += '  // Nodes\n';

    for (const node of this.nodes) {
      dot += `  X${node.name} [label=<${node.details.get('parent')}${node.details.get('name')}<BR/><FONT POINT-SIZE="8">${node.details.get('type')}</FONT>>]\n`;
    }

    dot += '  // Paths\n';
    for (const edge of this.edges) {
      dot += `  X${edge.from}->X${edge.to}\n`;
    }

    dot += '}';
    return dot;
  }

  public toJson() {
    let jsonRepresentation = new Array<ComponentNode>();
    for (const node of this.nodes) {
        let jsonNode: ComponentNode = {id: node.name, name: (node.details.get('name') as String).valueOf(), type: (node.details.get('type') as String).valueOf(), parent: (node.details.get('parent') as String).valueOf()};
        jsonRepresentation.push(jsonNode);
    }

    return { nodes: jsonRepresentation, edges: Array.from(this.edges) };
  }

  public getParentRecords(): Map<string, string> {
    // Put all info into a Map
    const parentRecords = new Map();

    this.populateIdToDeveloperNameMap(parentRecords, this.validationRules, 'EntityDefinitionId');
    this.populateIdToDeveloperNameMap(parentRecords, this.customFields, 'TableEnumOrId');
    this.populateIdToDeveloperNameMap(parentRecords, this.quickActions, 'SobjectType');

    return parentRecords;
  }

  public async retrieveRecords<T>(query: string) {
    return (await this.tooling.query<T>(query)).records;
  }

  public async retrieveCustomFields(ids: string[]): Promise<CustomField[]> {
    const query = `SELECT Id, TableEnumOrId FROM CustomField c WHERE c.Id In ${this.arrayToInIdString(ids)}`;
    return await this.retrieveRecords<CustomField>(query);
  }

  public async retrieveLookupRelationships(ids: string[]): Promise<FieldDefinition[]> {
    const query = `SELECT EntityDefinitionId,DataType,DurableId FROM FieldDefinition c WHERE c.EntityDefinitionId In ${this.arrayToInIdString(ids)}`;
    return await this.retrieveRecords<FieldDefinition>(query);
  }

  public async retrieveValidationRules(ids: string[]): Promise<ValidationRule[]> {
    const query = `SELECT Id, EntityDefinitionId FROM ValidationRule c WHERE c.Id In ${this.arrayToInIdString(ids)}`;
    return await this.retrieveRecords<ValidationRule>(query);
  }

  public async retrieveQuickActions(ids: string[]): Promise<QuickAction[]> {
    const query = `SELECT Id, SobjectType FROM QuickActionDefinition c WHERE c.Id In ${this.arrayToInIdString(ids)}`;
    return await this.retrieveRecords<QuickAction>(query);
  }

  public async retrieveCustomObjects(ids: string[]): Promise<CustomObject[]> {
    const query = `SELECT Id, DeveloperName FROM CustomObject c WHERE c.Id In ${this.arrayToInIdString(this.getObjectIds())}`;
    return await this.retrieveRecords<CustomObject>(query);
  }

  public getLookupRelationships(): FieldDefinition[] {
    return this.customFieldDefinitions;
  }

  private async retrieveAllComponentIds(): Promise<string[]> {
    const query = "SELECT MetadataComponentId,RefMetadataComponentId FROM MetadataComponentDependency WHERE (MetadataComponentType = 'CustomField' OR RefMetadataComponentType = 'CustomField') OR (MetadataComponentType = 'ValidationRule' OR RefMetadataComponentType = 'ValidationRule')";

    // Get all Custom Field Ids in MetadataComponent and RefMetadata Component
    const customComponentIds = await this.retrieveRecords<MetadataComponentDependency>(query);

    const componentIds = customComponentIds.map(r => r.MetadataComponentId);
    const refComponentIds = customComponentIds.map(r => r.RefMetadataComponentId);

    // Concat both lists of ids
    let ids = componentIds.concat(refComponentIds);
    // Remove duplicates
    ids = Array.from(new Set(ids));

    return ids;
  }

  private getObjectIds() {
    // Filter Ids that start with 0
    const fieldObjectIdRecords = this.customFields.filter(x => x.TableEnumOrId.startsWith('0'));
    // Filter Ids that start with 0 from vrule
    const vruleObjectIdRecords = this.validationRules.filter(x => x.EntityDefinitionId.startsWith('0'));

    return [
      ...fieldObjectIdRecords.map(r => r.TableEnumOrId),
      ...vruleObjectIdRecords.map(r => r.EntityDefinitionId)
    ];
  }

  private populateIdToDeveloperNameMap<T>(map: Map<string, string>, records: T[], fieldName: string): void {
    for (const record of records) {
      let val = record[fieldName];
      if (val.startsWith('0')) {
        // Grab the custom object the field points to
        const customObject = this.customObjects.filter(x => x.Id.startsWith(val));
        val = customObject[0].DeveloperName + '__c';
      }
      map.set(record['Id'], val);
    }
  }

  private arrayToInIdString(ids) {
    return `('${ids.join('\',\'')}')`;
  }
}

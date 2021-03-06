import _ from 'lodash';

// Test whether a key is a special Swagger extension.
function isExtension(value, key) {
  return _.startsWith(key, 'x-');
}

export function parseReference(reference) {
  const parts = reference.split('/');

  if (parts[0] !== '#') {
    throw new Error('Schema reference must start with document root (#)');
  }

  if (parts[1] !== 'definitions' || parts.length !== 3) {
    throw new Error('Schema reference must be reference to #/definitions');
  }

  const id = parts[2];

  return id;
}

/**
 * Lookup a reference
 *
 * Resolves a reference in the given root schema. An optional depth argument
 * can be provided to limit resolution to a certain level. For example to
 * limit the `#/definitions/User/properties/name` reference lookup to just a
 * depth `#/definitions/User`, a depth of 3 can be supplied.
 *
 * @param reference {string} - Example: #/definitions/User/properties/name
 * @param root {object} - The object to resolve the given reference
 * @param depth {number} - A limit to resolving the depth
 */
export function lookupReference(reference, root, depth) {
  const parts = reference.split('/').reverse();

  if (parts.pop() !== '#') {
    throw new Error('Schema reference must start with document root (#)');
  }

  if (parts.pop() !== 'definitions') {
    throw new Error('Schema reference must be reference to #/definitions');
  }

  const id = parts[parts.length - 1];
  let value = root.definitions;

  // ['#', 'definitions'] (2)
  let currentDepth = 2;

  while (parts.length > 0 && value !== undefined) {
    const key = parts.pop();
    value = value[key];
    currentDepth += 1;

    if (depth && depth === currentDepth) {
      break;
    }
  }

  if (value === undefined) {
    throw new Error(`Reference to ${reference} does not exist`);
  }

  return {
    id,
    referenced: value,
  };
}

function pathHasCircularReference(paths, path, reference) {
  const currentPath = (path || []).join('/');

  // Check for direct circular reference
  if (currentPath.startsWith(reference)) {
    return true;
  }

  // Check for indirect circular Reference
  if ((paths || []).find(p => p.startsWith(reference))) {
    return true;
  }

  return false;
}

export function dereference(example, root, paths, path) {
  if (example === null || example === undefined) {
    return example;
  }

  if (example.$ref && _.isString(example.$ref)) {
    const refPath = example.$ref.split('/');
    const currentPath = (path || []).join('/');

    if (path && pathHasCircularReference(paths, path, example.$ref)) {
      return null;
    }

    const ref = lookupReference(example.$ref, root);

    const newPaths = (paths || []).concat([currentPath]);
    return dereference(ref.referenced, root, newPaths, refPath);
  }

  if (_.isArray(example)) {
    return example.map(value => dereference(value, root, paths, path));
  }

  if (_.isObject(example)) {
    const result = {};

    _.forEach(example, (value, key) => {
      result[key] = dereference(value, root, paths, (path || []).concat([key]));
    });

    return result;
  }

  return example;
}

function convertSubSchema(schema, references, swagger) {
  if (schema.$ref) {
    references.push(schema.$ref);
    return { $ref: schema.$ref };
  }

  const recurseConvertSubSchema = s => convertSubSchema(s, references, swagger);

  let actualSchema = _.omit(schema, ['discriminator', 'readOnly', 'xml', 'externalDocs', 'example']);
  actualSchema = _.omitBy(actualSchema, isExtension);
  actualSchema = _.cloneDeep(actualSchema);

  if (schema.type === 'file') {
    // file is not a valid JSON Schema type let's pick string instead
    actualSchema.type = 'string';
  }

  if (schema.example) {
    actualSchema.examples = [dereference(schema.example, swagger)];
  }

  if (schema['x-nullable']) {
    if (actualSchema.type) {
      actualSchema.type = [actualSchema.type, 'null'];
    } else if (actualSchema.enum === undefined) {
      actualSchema.type = 'null';
    }

    if (actualSchema.enum && !actualSchema.enum.includes(null)) {
      actualSchema.enum.push(null);
    }
  }

  if (schema.allOf) {
    actualSchema.allOf = schema.allOf.map(recurseConvertSubSchema);
  }

  if (schema.anyOf) {
    actualSchema.anyOf = schema.anyOf.map(recurseConvertSubSchema);
  }

  if (schema.oneOf) {
    actualSchema.oneOf = schema.oneOf.map(recurseConvertSubSchema);
  }

  if (schema.not) {
    actualSchema.not = recurseConvertSubSchema(schema.not);
  }

  // Array

  if (schema.items) {
    if (Array.isArray(schema.items)) {
      actualSchema.items = schema.items.map(recurseConvertSubSchema);
    } else {
      actualSchema.items = recurseConvertSubSchema(schema.items);
    }
  }

  if (schema.additionalItems && typeof schema.additionalItems === 'object') {
    actualSchema.additionalItems = recurseConvertSubSchema(schema.additionalItems);
  }

  // Object

  if (schema.properties) {
    Object.keys(schema.properties).forEach((key) => {
      actualSchema.properties[key] = recurseConvertSubSchema(schema.properties[key]);
    });
  }

  if (schema.patternProperties) {
    Object.keys(schema.patternProperties).forEach((key) => {
      actualSchema.patternProperties[key] =
        recurseConvertSubSchema(schema.patternProperties[key]);
    });
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    actualSchema.additionalProperties = recurseConvertSubSchema(schema.additionalProperties);
  }

  return actualSchema;
}

/** Returns true if the given schema contains any references
 */
function checkSchemaHasReferences(schema) {
  if (schema.$ref) {
    return true;
  }

  return Object.values(schema).some((value) => {
    if (_.isArray(value)) {
      return value.some(checkSchemaHasReferences);
    } else if (_.isObject(value)) {
      return checkSchemaHasReferences(value);
    }

    return false;
  });
}

/** Traverses the entire schema to find all of the references
 * @returns array of each reference that is found in the schema
 */
function findReferences(schema) {
  if (schema.$ref) {
    return [schema.$ref];
  }

  let references = [];

  if (schema.allOf) {
    references = references.concat(...schema.allOf.map(findReferences));
  }

  if (schema.anyOf) {
    references = references.concat(...schema.anyOf.map(findReferences));
  }

  if (schema.oneOf) {
    references = references.concat(...schema.oneOf.map(findReferences));
  }

  if (schema.not) {
    references = references.concat(...findReferences(schema.not));
  }

  // Array

  if (schema.items) {
    if (Array.isArray(schema.items)) {
      references = references.concat(...schema.items.map(findReferences));
    } else {
      references = references.concat(findReferences(schema.items));
    }
  }

  if (schema.additionalItems && typeof schema.additionalItems === 'object') {
    references = references.concat(findReferences(schema.additionalItems));
  }

  // Object

  if (schema.properties) {
    Object.keys(schema.properties).forEach((key) => {
      references = references.concat(findReferences(schema.properties[key]));
    });
  }

  if (schema.patternProperties) {
    Object.keys(schema.patternProperties).forEach((key) => {
      references = references.concat(findReferences(schema.patternProperties[key]));
    });
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    references = references.concat(findReferences(schema.additionalProperties));
  }

  return references;
}

/** Convert Swagger schema to JSON Schema
 * @param schema - The Swagger schema to convert
 * @param root - The document root (this contains the JSON schema definitions)
 * @param swagger - The swagger document root (this contains the Swagger schema definitions)
 * @param copyDefinitins - Whether to copy the referenced definitions to the resulted schema
 */
export function convertSchema(schema, root, swagger, copyDefinitions = true) {
  let references = [];
  const result = convertSubSchema(schema, references, swagger);

  if (copyDefinitions) {
    if (references.length !== 0) {
      result.definitions = {};
    }

    while (references.length !== 0) {
      const lookup = lookupReference(references.pop(), root, 3);

      if (result.definitions[lookup.id] === undefined) {
        references = references.concat(findReferences(lookup.referenced));
        result.definitions[lookup.id] = lookup.referenced;
      }
    }
  }

  if (result.$ref && copyDefinitions) {
    const reference = lookupReference(result.$ref, root);

    if (!checkSchemaHasReferences(result.definitions[reference.id])) {
      // Dereference the root reference if possible
      return result.definitions[reference.id];
    }

    // Wrap any root reference in allOf because faker will end up in
    // loop with root references which is avoided with allOf
    return {
      allOf: [{ $ref: result.$ref }],
      definitions: result.definitions,
    };
  }

  return result;
}

export function convertSchemaDefinitions(definitions) {
  const jsonSchemaDefinitions = {};

  if (definitions) {
    _.forEach(definitions, (schema, key) => {
      jsonSchemaDefinitions[key] = convertSchema(schema, { definitions }, { definitions }, false);
    });
  }

  return jsonSchemaDefinitions;
}

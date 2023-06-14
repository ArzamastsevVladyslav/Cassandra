const { getTypeByData } = require('./typeHelper');
const { commentDeactivatedStatement, getApplyDropStatement, tab } = require('./generalHelper');
const { mergeValuesWithConfigOptions } = require('./tableHelper');
const { getDiff } = require('./tableOptionService/getDiff');
const { parseToString } = require('./tableOptionService/parseToString');
const { dependencies } = require('./appDependencies');
const { getKeySpaceScript } = require('./updateHelpers/keySpaceHelper');
const { checkIsOldModel, fieldTypeCompatible } = require('./updateHelpers/generalHelper');
const { getViewScript } = require('./updateHelpers/viewHelper');
const { getIndexTable, getDataColumnIndex } = require('./updateHelpers/indexHelper');
const { getUdtScript, sortAddedUdt } = require('./updateHelpers/udtHelper');
const { 
	alterTablePrefix, 
	getDelete, 
	hydrateColumn, 
	isTableChange, 
	addScriptToExistScripts,
	getAdd,
	getDeleteTable,
	getAddTable,
} = require('./updateHelpers/tableHelper');
const { getUdtMap } = require('./udtHelper');
const { AlterScriptDto } = require("./types/AlterScriptDto");

let _;

const setDependencies = ({ lodash }) => _ = lodash;

const getUpdateType = updateTypeData => 
	`${alterTablePrefix(updateTypeData.tableName, updateTypeData.keySpace)} 
	ALTER "${updateTypeData.columnData.name}" TYPE ${updateTypeData.columnData.type};`;

const renameColumnStatement = columnData => `RENAME "${columnData.oldName}" TO "${columnData.newName}"`;

const getRenameColumn = renameData => {
	const script = 
	`${alterTablePrefix(renameData.tableName, renameData.keyspaceName)} ${renameColumnStatement(renameData.columnData)};`;
	return [
		AlterScriptDto.getInstance(
			[script],
			true,
			'modify',
			'field'
		)
	];
};
const objectContainsProp = (object, key) => !!object[key];

const isCommentNew = comment => comment && comment.new && comment.new !== comment.old;
const getChangeOption = ({ options, comment }) => {
	const optionsDiff = getDiff(options.new || {}, options.old || {});
	const configOptionsWithValues = mergeValuesWithConfigOptions(optionsDiff);
	return isCommentNew(comment)
		? parseToString(configOptionsWithValues, comment.new)
		: parseToString(configOptionsWithValues);
};

const getCollectionName = compMod => {
	const { collectionName = {}, code = {} } = compMod;
	return {
		oldName: code.old || collectionName.old,
		newName: code.new || collectionName.new,
	}
}

const getUpdateColumnProvider = {
	alterDropCreate({ dataForScript, oldName, newName }) {
		const getData = columnData => ({ ...dataForScript, columnData: { ...dataForScript.columnData, ...columnData }});
		const deletePropertyScript = getDelete(getData({ name: oldName }));
		const addPropertyScript = getAdd(getData({ name: newName }));
		return [...deletePropertyScript, ...addPropertyScript];
	},

	alterName(hydratedColumn) {
		const { newName, oldName, dataForScript, property, isTypeChange } = hydratedColumn;
		if (property.primaryKey && isTypeChange) {
			return [];
		}
		if (!property.primaryKey) {
			return this.alterDropCreate(hydratedColumn);
		}
		return getRenameColumn({ ...dataForScript, columnData: { oldName, newName } }); 
	},

	alterType(hydratedColumn) {
		const { isOldModel, oldType, newType, dataForScript, property } = hydratedColumn;
		if (!oldType || !newType || property.primaryKey) {
			return [];
		}
		const isFieldTypeCompatible = fieldTypeCompatible(oldType, newType);
		
		if (isOldModel) {
			if (!isFieldTypeCompatible) {
				return this.alterDropCreate(hydratedColumn);
			}
			const script = getUpdateType(dataForScript);
			return [
				AlterScriptDto.getInstance(
					[script],
					true,
					'modify',
					'field'
				)
			];
		} 

		return this.alterDropCreate(hydratedColumn);
	}
};

const getUpdate = updateData => {
	const hydratedColumn = hydrateColumn(updateData);
	const { newName, oldName } = hydratedColumn;
	if (!oldName || !newName) {
		return [];
	}
	if (hydratedColumn.isNameChange) {
		return getUpdateColumnProvider.alterName(hydratedColumn);
	} else if (hydratedColumn.isTypeChange) {
		return getUpdateColumnProvider.alterType(hydratedColumn);
	}
	addScriptToExistScripts(hydratedColumn.dataForScript);

	return [];
};

const getIsColumnInIndex = (item, columnName, data) => {
	const itemData = { properties: item.properties || {}, ..._.omit(item.role || {}, ['properties']) };

	const dataSources = [itemData, data.modelDefinitions];
	const secIndexes = _.get(item, 'role.SecIndxs', [])
		.map(index => getDataColumnIndex({ dataSources, idToNameHashTable: {}, column: index, key: 'SecIndxKey' }))
		.map(index => index.name)
		.filter(Boolean);
	const searchIndexes = _.get(item, 'role.searchIndexColumns', [])
		.map(index => getDataColumnIndex({ dataSources, idToNameHashTable: {}, column: index }))
		.map(index => index.name)
		.filter(Boolean);
	return [...searchIndexes, ...secIndexes].includes(columnName);
};

const getPropertiesForUpdateTable = (properties = [])=> {
	const newProperties = Object.entries(properties).map(([name, value]) => {
		if (!value.compMod) {
			return [name, value];
		}
		const newField = value.compMod?.newField || {};
		const oldField = value.compMod?.oldField || {};
		Object.entries(newField).map(([keyNewField, valueNewField]) => {
			if (oldField[keyNewField] !== valueNewField) {
				value[keyNewField] = valueNewField;
			}
			if (keyNewField === 'name' && oldField[keyNewField] !== valueNewField) {
				name = valueNewField;
			}
		})
		return [name, value];
	})
	return Object.fromEntries(newProperties);
} 

const getUpdateTable = updateData => {
	const { item, propertiesScript = [] } = updateData;
	const { oldName, newName } = getCollectionName(item.role?.compMod);

	const compModeWithName = { ...item.role?.compMod || {}, name: { new: newName, old: oldName } }

	const tableIsChange = isTableChange({ 
		item: { 
			...item, 
			role: { ...item.role, compMod: compModeWithName },
		},
		data: updateData.data,
		dataSources: updateData.dataSources,
	});
	const indexTableScript = getIndexTable(item, updateData.data, tableIsChange);

	if (!tableIsChange) {
		const tableName = updateData.tableName || oldName || newName;
		const optionScript = getOptionsScript(item.role?.compMod || {}, tableName, updateData.isOptionScript);
		return [
				AlterScriptDto.getInstance(
					[optionScript],
					true,
					'modify',
					'table'
				),
				...indexTableScript,
				...propertiesScript
		];
	}
		
	if (!oldName || !newName) {
		return [];
	}

	const data = { 
		keyspaceName: updateData.keyspaceName,
		data: updateData.data,
		item: {
			...item,
			properties: getPropertiesForUpdateTable(item.role?.properties || item.properties),
			role: {
				...(item?.role || {}),
				tableOptions: item?.role?.compMod?.['tableOptions'] || {},
			}
		},
		isKeyspaceActivated: true,
		dataSources: updateData.dataSources,
	};
	const deleteScript = getDeleteTable({ ...data, tableName: oldName });
	const addScript = getAddTable({ ...data, tableName: newName});
	return [...deleteScript, ...addScript, ...indexTableScript];
}

const getOptionsScript = (compMod, tableName, isGetOptionScript) => {
	if (!isGetOptionScript || !compMod || !compMod.tableOptions) {
		return '';
	}
	
	const script = getChangeOption({
		options: compMod.tableOptions,
		comment: compMod.comments
	});

	return script ? `${alterTablePrefix(tableName, compMod.keyspaceName)}${tab(script)};` : '';
}

const handleChange = (child, udtMap, generator, data) => {
	let alterTableScript = [];

	if (objectContainsProp(child, 'items') && child.items.length) {
		const alterScript = child.items.reduce((result, current) => {
			return result.concat(handleItem(current, udtMap, generator, data));
		}, []);
		alterTableScript = alterTableScript.concat(alterScript);
	} else if (objectContainsProp(child, 'items')) {
		alterTableScript = alterTableScript.concat(handleItem(child.items, udtMap, generator, data));
	}

	return alterTableScript;
}

const handleItem = (item, udtMap, generator, data) => {
	let alterTableScript = [];

	if (!objectContainsProp(item, 'properties')) {
		return alterTableScript;
	}

	const isOldModel = checkIsOldModel(_.get(data, 'modelData'));
	const itemProperties = item.properties;

	alterTableScript = Object.keys(itemProperties)
		.reduce((alterTableScript, tableKey) => {
			const itemCompModData = itemProperties[tableKey].role.compMod;
			const codeName = _.get(itemProperties, `${tableKey}.role.code`, '');
			const tableName = codeName.length ? codeName : tableKey;

			if (!itemCompModData) {
				return alterTableScript;
			}

			const tableProperties = itemProperties[tableKey].properties || {};

			const keyspaceName = itemCompModData.keyspaceName;

			if (itemCompModData.deleted) {
				const deletedIndexScript = getIndexTable(itemProperties[tableKey], data);
				return [ 
					...alterTableScript, 
					...getDeleteTable({
						keyspaceName,
						tableName
					}),
					...deletedIndexScript,
				];
			}

			const dataSources = [
				data.modelDefinitions,
				data.internalDefinitions,
				data.externalDefinitions,
				{ properties: tableProperties },
				{ properties: _.get(itemProperties[tableKey], 'role.properties', [])},
				{ properties: _.get(itemProperties[tableKey], 'role.compMod.newProperties', []) },
				{ properties: _.get(itemProperties[tableKey], 'role.compMod.oldProperties', []) }
			];

			if (itemCompModData.created) {
				const addedIndexScript = getIndexTable(itemProperties[tableKey], data);
				return [ 
					...alterTableScript, 
					...getAddTable({
						item: itemProperties[tableKey], 
						keyspaceName,
						data, 
						tableName,
						dataSources,
					}),
					...addedIndexScript,
				];
			}

			if (itemCompModData.modified) {
				const updateTableScript = getUpdateTable({ keyspaceName, data, item: itemProperties[tableKey], isOptionScript: true, tableName, dataSources });

				return [...alterTableScript, ...updateTableScript];
			}

			const propertiesScript = handleProperties({ 
				item: itemProperties[tableKey],
				generator,
				tableProperties, 
				udtMap, 
				itemCompModData, 
				tableName, 
				isOldModel,
				data,
				dataSources,
			});

			const updateTableScript = getUpdateTable({ 
				item: itemProperties[tableKey], 
				isOptionScript: generator.name === 'getUpdate',
				propertiesScript,
				keyspaceName,
				tableName,
				data,
				dataSources,
			})

			return [...alterTableScript, ...updateTableScript];
		}, []);

	return alterTableScript;
}

const handleProperties = ({ generator, tableProperties, udtMap, itemCompModData, tableName, isOldModel, data, item, dataSources }) => {
	return Object.keys(tableProperties)
		.reduce((alterTableScript, columnName) => {
			const property = tableProperties[columnName];
			if (generator.name !== 'getUpdate' && (property.compositePartitionKey || property.compositeClusteringKey)) {
				return alterTableScript;
			}
			if (generator.name === 'getAdd' && (property || {}).hasOwnProperty('compMod')) {
				return alterTableScript;
			}
			let columnType = getTypeByData(property, udtMap, columnName);
			
			if (property.$ref && !columnType) {
				columnType = _.last(property.$ref.split('/'));
			}

			if (!columnType) {
				return alterTableScript;
			}

			const keyspaceName = itemCompModData?.keyspaceName;

			const isColumnInIndex = getIsColumnInIndex(item, columnName, data);

			if (generator.name === 'getUpdate' && (!property.compMod || isColumnInIndex)) {
				return alterTableScript;
			}

			return [
				...alterTableScript,
				...generator({
					keyspaceName,
					tableName,
					columnData: {
						name: columnName,
						type: columnType
					},
					property,
					isOldModel,
					udtMap,
					dataSources,
				})
			];
		}, []);
}

const columns = {
	views: getViewScript,
	containers: getKeySpaceScript,
	udt: getUdtScript,
}

const generateScript = (child, udtMap, data, column, mode) => {
	if (!child) {
		return [];
	}
	const getScript = columns[column];

	if (Array.isArray(child) && child.length) {
		return child.reduce((scriptsData, item) => 
			([...scriptsData, 
				...getScript({ child: item.properties[Object.keys(item.properties)[0]], udtMap, data, mode })]), 
			[]);
	}
	const properties = child.properties;
	const itemKey = Object.keys(properties)[0];
	const item = properties[itemKey];

	return getScript({ child: item, udtMap, data, mode });
}

const getAlterTableScript = (child, udtMap, data) => {
	const addedEntities = child?.properties?.entities?.properties?.added;
	const modifiedEntities = child?.properties?.entities?.properties?.modified;
	const deletedEntities = child?.properties?.entities?.properties?.deleted;
	
	const addedEntitiesScripts = handleChange(addedEntities, udtMap, getAdd, data)
	const modifiedEntitiesScripts = handleChange(modifiedEntities, udtMap, getUpdate, data);
	const modifiedEntitiesScript = handleChange(deletedEntities, udtMap, getDelete, data);

    const addedContainers = child?.properties?.containers?.properties?.added;
    const modifiedContainers = child?.properties?.containers?.properties?.modified;
    const deletedContainers = child?.properties?.containers?.properties?.deleted;

	let addedContainersScripts = [];
	let modifiedContainersScripts = [];
	let deletedContainersScript = [];
	
	if (!data?.scriptOptions?.containers?.skipModified) {
		addedContainersScripts = generateScript(addedContainers?.items, udtMap, data, 'containers', 'add');
		modifiedContainersScripts = generateScript(modifiedContainers?.items, udtMap, data, 'containers', 'update');
		deletedContainersScript = generateScript(deletedContainers?.items, udtMap, data, 'containers', 'delete');
	}
	
    const addedViews = child?.properties?.views?.properties?.added;
    const modifiedViews = child?.properties?.views?.properties?.modified;
    const deletedViews = child?.properties?.views?.properties?.deleted;
		
    const addedViewsScripts = generateScript(addedViews?.items, udtMap, data, 'views', 'add');
    const modifiedViewsScripts = generateScript(modifiedViews?.items, udtMap, data, 'views', 'update');
    const deletedViewsScript = generateScript(deletedViews?.items, udtMap, data, 'views', 'delete');

	const modelDefinitions = child?.properties?.modelDefinitions;
    const sortAddedUdtResult = sortAddedUdt(modelDefinitions);
    const addedModelDefinitions = sortAddedUdtResult?.properties?.added;
    const modifiedModelDefinitions = sortAddedUdtResult?.properties?.modified;
    const deletedModelDefinitions = sortAddedUdtResult?.properties?.deleted;
	
    const addedModelDefinitionsScripts = generateScript(addedModelDefinitions.items, udtMap, data, 'udt', 'add');
    const modifiedModelDefinitionsScripts = generateScript(modifiedModelDefinitions.items, udtMap, data, 'udt', 'update');
    const deletedModelDefinitionsScript = generateScript(deletedModelDefinitions.items, udtMap, data, 'udt', 'delete');
	
	return [
			...modifiedEntitiesScripts,
			...addedEntitiesScripts,
			...modifiedEntitiesScript,
			...addedContainersScripts,
			...modifiedContainersScripts,
			...deletedContainersScript,
			...modifiedViewsScripts,
			...addedViewsScripts,
			...deletedViewsScript,
			...addedModelDefinitionsScripts,
			...modifiedModelDefinitionsScripts,
			...deletedModelDefinitionsScript
	].filter(Boolean);
}

const getAlterScript = (child, udtMap, data) => {
	setDependencies(dependencies);
	const generalUdtTypeMap = Object.assign(
		{},
		udtMap,
		getUdtMap([child])
	);
	let scriptData = getAlterTableScript(child, generalUdtTypeMap, data);
	scriptData = _.uniqWith(scriptData, _.isEqual);
	scriptData = getCommentedDropScript(scriptData, data);
	scriptData = sortScript(scriptData);
	return scriptData.filter(Boolean).join('\n\n');
}

const getCommentedDropScript = (scriptsData, data) => {
	const applyDropStatements = getApplyDropStatement(data);
	if (applyDropStatements) {
		return scriptsData;
	}
	return scriptsData.map((dto = {}) => {
		if (!dto?.scripts[0]?.isDropScript || !dto?.scripts[0]?.script) {
			return dto;
		}
		return {
			...dto,
			scripts: dto.scripts.map(scriptObject => {
				return {
					...scriptObject,
					script: commentDeactivatedStatement(scriptObject.script, false)
				}
				
			})
		};
	})
}

const isDropInStatements = (child, udtMap, data) => {
	setDependencies(dependencies);
	const scriptsData = getAlterTableScript(child, udtMap, data);
	return scriptsData.flatMap(dto => dto.scripts).some(scriptData => !!scriptData.script && scriptData.isDropScript);
}

const sortScript = (scriptDto) => {
	const scriptData = scriptDto.flatMap(dto => dto.scripts);
	const filterProp = (key, prop, script = {}) => script[key] && script.modelLevel === prop;
	const filter = (scriptType, scriptData, modelLevel) => {
		return scriptData.reduce((scripts, currentScript) => {
			if (filterProp(scriptType, modelLevel, currentScript)) {
				scripts.scripts.push(currentScript);
				return scripts;
			}

			scripts.filteredScripts.push(currentScript);

			return scripts;
		}, { scripts: [], filteredScripts: [] });
	};

	const orderForScripts = [
		['keySpaces', 'isAddScript'],
		['keySpaces', 'isModifyScript'],
		['view', 'isDropScript'],
		['index', 'isDropScript'],
		['renewal', 'isDropScript'],
		['table', 'isDropScript'],
		['udt', 'isDropScript'],
		['udt', 'isAddScript'],
		['udt', 'isModifyScript'],
		['table', 'isAddScript'],
		['table', 'isModifyScript'],
		['field', 'isDropScript'],
		['field', 'isAddScript'],
		['field', 'isModifyScript'],
		['index', 'isAddScript'],
		['index', 'isModifyScript'],
		['renewal', 'isAddScript'],
		['view', 'isAddScript'],
		['view', 'isModifyScript'],
		['udf', 'isDropScript'],
		['udf', 'isAddScript'],
		['keySpaces', 'isDropScript'],
	];
	const sortedScripts = orderForScripts.reduce((script, [modelLevel, scriptType]) => {
		const { scripts, filteredScripts } = filter(scriptType, script.filteredScripts, modelLevel);
		return {
			sorted: [...script.sorted, ...scripts],
			filteredScripts
		}
	}, {
		sorted: [],
		filteredScripts: scriptData
	});

	return [...sortedScripts.sorted, ...sortedScripts.filteredScripts].map(data => data.script);
}

module.exports = {
	getAlterScript,
	isDropInStatements
};
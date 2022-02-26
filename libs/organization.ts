// //  Copyright PrimeObjects Software Inc. and other contributors <https://www.primeobjects.com/>
// // 
// //  This source code is licensed under the MIT license.
// //  The detail information can be found in the LICENSE file in the root directory of this source tree.

import { _track, isNonEmptyString } from 'douhub-helper-util';
import { CheckCallerResult, HTTPERROR_400, onError, LambdaResponse, 
    ERROR_PARAMETER_MISSING, getPropValueOfEvent ,checkCaller, onSuccess, HTTPERROR_500 } from 'douhub-helper-lambda';
import {cosmosDBQuery} from 'douhub-helper-service';

export const retrieveCategoriesTags = async (event: any, type: 'categories' | 'tags' | 'both'): Promise<LambdaResponse> => {
    const apiName = 'organization.retrieveCategories';
    try {
        const caller: CheckCallerResult = await checkCaller(event, { apiName, needAuthorization: true });
        if (caller.type == 'STOP') return onSuccess(caller);
        if (caller.type == 'ERROR') throw caller.error;

        const regardingEntityName = getPropValueOfEvent(event, 'regardingEntityName');
        if (!isNonEmptyString(regardingEntityName)) {
            throw {
                ...HTTPERROR_400,
                type: ERROR_PARAMETER_MISSING,
                source: apiName,
                detail: {
                    reason: 'The regardingEntityName is not provided.'
                }
            }
        }

        const regardingEntityType = getPropValueOfEvent(event, 'regardingEntityType');

        const query = `SELECT * FROM c WHERE ${type == 'both' ? '(c.entityName=@entityName1 OR c.entityName=@entityName2)' : 'c.entityName=@entityName1'} AND c.organizationId=@organizationId AND c.regardingEntityName=@regardingEntityName ${isNonEmptyString(regardingEntityType) ? 'AND c.regardingEntityType=@regardingEntityType' : ''}`;
        const parameters = [
            {
                name: '@entityName1',
                value: type == 'tags' ? 'Tag' : 'Category'
            },
            {
                name: '@entityName2',
                value: type == 'both' ? 'Tag' : 'Category'
            },
            {
                name: '@organizationId',
                value: caller.context.organizationId
            },
            {
                name: '@regardingEntityName',
                value: regardingEntityName
            },
            {
                name: '@regardingEntityType',
                value: regardingEntityType
            }

        ];

        const response = (await cosmosDBQuery(query, parameters, { includeAzureInfo: false }));
        const results = type == 'both' ? response : (response.length > 0 ? response[0] : { entityName: type == 'categories' ? 'Category' : 'Tag', regardingEntityName, regardingEntityType, data: [] })
       
        return onSuccess(results);
    }
    catch (error) {
        if (_track) console.error({ error });
        throw new Error(JSON.stringify(onError({
            ...HTTPERROR_500,
            source: apiName
        }, error)));
    }
};


// export const updateOrganization = async (context: Record<string,any>, data: Record<string,any>) => {

//     if (!isObject(data) || isObject(data) && !isNonEmptyString(data.id)) {
//         throw {
//             ...HTTPERROR_400,
//             type: ERROR_PARAMETER_MISSING,
//             source: 'organization.updateOrganization',
//             detail: {
//                 reason: 'The parameter (data.id) is not provided.',
//                 data
//             }
//         }
//     }
   
//     //some entities is not allowed to be updated here
//     if (data.entityName != 'Organization') {
//         throw {
//             ...HTTPERROR_400,
//             type: 'ERROR_PARAMETER_ENTITY_IS_NOT_ORGANIZATION',
//             source: 'context.checkCaller'
//         }
//    }

//     const cx = await _.cx(event);
//     const user = cx.context.userId;
//     try {

//         const result = (await _.processDataForUpsert(cx, data));
//         data = result.data;
//         if (!checkRecordPrivilege(cx.context, result.existingData, 'update')) {
//             throw `The user ${user.id} has no permission to update the organization (${data.id}).`;
//         }

//         data = await cosmosDb.update(cx, data, false);
//         data.id = `organization.${data.id}`;

//         await dynamoDb.upsert(cx, data, `${process.env.PREFIX}-profile`, true);
//         data.id = data['_id'];

//         return _.onSuccess(callback, cx, data);
//     }
//     catch (error) {
//         return _.onError(callback, cx, error, 'ERROR_API_DATA_UPDATE', `Failed to update organization (id:${data.id})`);
//     }
// }


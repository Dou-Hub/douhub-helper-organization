// //  Copyright PrimeObjects Software Inc. and other contributors <https://www.primeobjects.com/>
// // 
// //  This source code is licensed under the MIT license.
// //  The detail information can be found in the LICENSE file in the root directory of this source tree.

import { _track, isNonEmptyString, hasRole, isObject } from 'douhub-helper-util';
import { isNil } from 'lodash';
import {
    CheckCallerResult, HTTPERROR_400, onError, LambdaResponse, getBooleanValueOfEvent, createToken, getToken,
    ERROR_PARAMETER_MISSING, HTTPERROR_403, checkCaller, onSuccess, HTTPERROR_500, ERROR_PERMISSION_DENIED
} from 'douhub-helper-lambda';
import { cosmosDBQuery, dynamoDBUpsert, DYNAMO_DB_TABLE_NAME_PROFILE } from 'douhub-helper-service';
import { updateRecord } from 'douhub-helper-data';


export const retrieveToken = async (event: any, type: 'api' | 'webhook'): Promise<LambdaResponse> => {
    const apiName = `organization.${type}`;
    try {
        const caller: CheckCallerResult = await checkCaller(event, { apiName, needUserProfile: true, needOrganizationProfile: true });
        if (caller.type == 'STOP') return onSuccess(caller);
        if (caller.type == 'ERROR') throw caller.error;
        const context = caller.context;

        const create = getBooleanValueOfEvent(event, 'create', false);
        const organizationId = context.organizationId;

        if (hasRole(context, "ORG-ADMIN") && isNonEmptyString(type)) {
            let token = await getToken(organizationId, type);
            if (!isNonEmptyString(token?.token) || create) {
                if (_track) console.log('create token')
                token = await createToken(organizationId, type, {});
            }

            if (!isNil(token)) return onSuccess(token);
        }

        return onSuccess({});
    }
    catch (error) {
        if (_track) console.error({ error });
        throw new Error(JSON.stringify(onError({
            ...HTTPERROR_500,
            source: apiName
        }, error)));
    }
};


export const retrieveCategoriesTags = async (organizationId: string, type: 'categories' | 'tags' | 'both', regardingEntityName: string, regardingEntityType?: string): Promise<Record<string, any>> => {
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
            value: organizationId
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

    const response = await cosmosDBQuery(query, parameters);
    return type == 'both' ? response : (response.length > 0 ? response[0] : {
        entityName: type == 'categories' ? 'Category' : 'Tag',
        regardingEntityName, regardingEntityType, data: []
    })

};


export const updateOrganization = async (context: Record<string, any>, organization: Record<string, any>): Promise<Record<string, any>> => {

    const source = 'updateOrganization';

    if (!(isObject(organization) && isNonEmptyString(organization.id))) {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source,
            detail: {
                reason: 'organization.id'
            }
        }
    }

    if (organization.entityName != 'Organization') {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source,
            detail: {
                reason: 'organization.entityName="Organization"'
            }
        }
    }

    if (!(hasRole(context, 'ORG-ADMIN') || organization.ownedBy==context.userId)) 
    {
        throw {
            ...HTTPERROR_403,
            type: ERROR_PERMISSION_DENIED,
            source,
            detail: {
                reason: 'The caller has no permission to update the organization. (Only the owner of the organization or the user with ORG-ADMIN role can update this organization record.)'
            }
        }
    }

    //updateRecord function will not change roles and licenses
    const newOrg = await updateRecord(context, organization, {skipSecurityCheck:true});

   
    await dynamoDBUpsert({ ...newOrg, id: `organization.${newOrg.id}` }, DYNAMO_DB_TABLE_NAME_PROFILE, true);

    return newOrg;
}
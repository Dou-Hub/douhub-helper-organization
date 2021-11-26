//  Copyright PrimeObjects Software Inc. and other contributors <https://www.primeobjects.com/>
// 
//  This source code is licensed under the MIT license.
//  The detail information can be found in the LICENSE file in the root directory of this source tree.

import { isObject, isNonEmptyString } from 'douhub-helper-util';
import { HTTPERROR_403, HTTPERROR_400, ERROR_PARAMETER_MISSING } from 'douhub-helper-lambda';
import { s3Get } from 'douhub-helper-service';
import { find, isNil, isBoolean, isNumber, isArray } from 'lodash';



export const updateOrganization = async (context: Record<string,any>, data: Record<string,any>) => {

    if (!isObject(data) || isObject(data) && !isNonEmptyString(data.id)) {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source: 'organization.updateOrganization',
            detail: {
                reason: 'The parameter (data.id) is not provided.',
                data
            }
        }
    }
   
    //some entities is not allowed to be updated here
    if (data.entityName != 'Organization') {
        throw {
            ...HTTPERROR_400,
            type: 'ERROR_PARAMETER_ENTITY_IS_NOT_ORGANIZATION',
            source: 'context.checkCaller'
        }
   }

    const cx = await _.cx(event);
    const user = cx.context.userId;
    try {

        const result = (await _.processDataForUpsert(cx, data));
        data = result.data;
        if (!checkRecordPrivilege(cx.context, result.existingData, 'update')) {
            throw `The user ${user.id} has no permission to update the organization (${data.id}).`;
        }

        data = await cosmosDb.update(cx, data, false);
        data.id = `organization.${data.id}`;

        await dynamoDb.upsert(cx, data, `${process.env.PREFIX}-profile`, true);
        data.id = data['_id'];

        return _.onSuccess(callback, cx, data);
    }
    catch (error) {
        return _.onError(callback, cx, error, 'ERROR_API_DATA_UPDATE', `Failed to update organization (id:${data.id})`);
    }
}


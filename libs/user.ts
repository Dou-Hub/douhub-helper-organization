//  Copyright PrimeObjects Software Inc. and other contributors <https://www.primeobjects.com/>
// 
//  This source code is licensed under the MIT license.
//  The detail information can be found in the LICENSE file in the root directory of this source tree.


import {
    cosmosDBDelete, cosmosDBQuery, cosmosDBRetrieve, cosmosDBUpdate,
    cosmosDBUpsert, createCognitoUser,
    dynamoDBCreate,
    dynamoDBDelete,
    dynamoDBUpsert,
    DYNAMO_DB_TABLE_NAME_PROFILE
} from 'douhub-helper-service';

import {
    isNonEmptyString, newGuid, utcISOString, _track,
    isEmail, isPhoneNumber, isPassword, serialNumber, isObject
} from 'douhub-helper-util';

import { assign, find, isNil, isArray, isNumber } from 'lodash';

import {
    createToken, onError,
    HTTPERROR_400, ERROR_PARAMETER_MISSING,
    getDomain, HTTPERROR_403,
    ERROR_PARAMETER_INVALID,
    ERROR_PERMISSION_DENIED
} from "douhub-helper-lambda";

import { checkEntityPrivilege, createRecord, hasRole, processUpsertData, updateRecord } from 'douhub-helper-data';

/*
Get the user organizations based on mobile number or email
Return all organizations user belong to. 
If there are more than one organizations for a user, the UI should ask user to choose one
*/
export const getUserOrgs = async (email?: string, mobile?: string, verificationCode?: string): Promise<Record<string, any>> => {

    const source = 'createUser';

    if (!isNonEmptyString(email) && !isNonEmptyString(mobile)) {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source,
            detail: {
                reason: 'email,mobile',
                parameters: { email, mobile }
            }
        }
    }

    if (!isEmail(email ? email : '') && !isPhoneNumber(mobile)) {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_INVALID,
            source,
            detail: {
                reason: 'email,mobile',
                parameters: { email, mobile }
            }
        }
    }


    if (isNonEmptyString(verificationCode)) {
        //We will need to verify the code first 
        if (!(await verifyUserCode(email, mobile, verificationCode))) {
            return onError({
                ...HTTPERROR_400,
                source,
                type: ERROR_PARAMETER_INVALID,
                detail: {
                    reason: 'email,mobile',
                    parameters: { verificationCode }
                }
            });
        }
    }

    const attributes = 'c.id, c.organizationId, c.emailVerifiedOn, c.mobileVerifiedOn, c.stateCode, c.statusCode, c.latestSignInOn, c.modifiedOn';
    const type = isNonEmptyString(email) ? 'email' : 'mobile';

    return await cosmosDBQuery(`SELECT ${attributes} FROM c 
        WHERE c.stateCode=0 AND c.entityName=@entityName 
        AND c.${type}=@value`, [
        {
            name: '@value',
            value: isNonEmptyString(email) ? email : mobile
        },
        {
            name: '@entityName',
            value: 'User'
        }
    ]);
};


export const verifyUserCode = async (email?: string, mobile?: string, verificationCode?: string): Promise<boolean> => {

    const users = await cosmosDBQuery(`SELECT * FROM c 
        WHERE c.email=@email AND c.emailVerificationCode=@verificationCode 
        OR c.mobile=@mobile AND c.mobileVerificationCode=@verificationCode`, [
        {
            name: '@email',
            value: isNonEmptyString(email) ? email : newGuid()
        },
        {
            name: '@mobile',
            value: isNonEmptyString(mobile) ? mobile : newGuid()
        },
        {
            name: '@verificationCode',
            value: verificationCode
        }
    ]);

    if (users.length == 0) return false;

    const user = assign({}, users[0], users[0].emailVerificationCode == verificationCode ?
        { emailVerifiedOn: utcISOString() } :
        { mobileVerifiedOn: utcISOString() });

    //direct cosmosDb update
    await cosmosDBUpdate(user);
    await dynamoDBUpsert({ ...user, id: `user.${user.id}` }, DYNAMO_DB_TABLE_NAME_PROFILE, true);
    return true;
};


export const createUser = async (context: Record<string,any>, user: Record<string,any>, password:string, organizationId?: string): Promise<Record<string,any>> => {

    const source = 'createUser';
    const callerUser = context.user;

    //delete the attribute that should not be provided during create user

    delete user.emailVerifiedOn;
    delete user.mobileVerifiedOn;

    if (!isNonEmptyString(user.email) && !isNonEmptyString(user.mobile)) {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source,
            detail: {
                reason: 'email,mobile',
                parameters: { email: user.email, mobile: user.mobile }
            }
        }
    }

    if (!isEmail(user.email) && !isPhoneNumber(user.mobile)) {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_INVALID,
            source,
            detail: {
                reason: 'email,mobile',
                parameters: { email: user.email, mobile: user.mobile }
            }
        }
    }

    //if organizationId is provied, it means the user will be created and added to the orgnization
    if (isNonEmptyString(organizationId)) {
        if (!(isObject(callerUser) && callerUser.organizationid != organizationId)) {
            throw {
                ...HTTPERROR_403,
                type: ERROR_PARAMETER_INVALID,
                source,
                detail: {
                    reason: 'The caller is from different organization.',
                    parameters: { callerId: callerUser?.organizationid, organizationId }
                }
            }
        }
        else {
            
            if (!checkEntityPrivilege(context, 'User', undefined, 'create')) {
                throw {
                    ...HTTPERROR_403,
                    type: ERROR_PERMISSION_DENIED,
                    source,
                    detail: {
                        reason: 'The caller has no permission to create the user in the organization.',
                        parameters: { callerId: callerUser?.id, organizationId }
                    }
                }
            }
        }
    }


    const solution = context.solution;

    if (!isPassword(password, solution.auth.passwordRules)) {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_INVALID,
            source,
            detail: {
                reason: 'email,mobile',
                parameters: { password }
            }
        }
    }

    const newUserId = newGuid();
    const newOrganizationId = organizationId ? null : newGuid();

    let createdCosmosOrganizationId = '';
    let createdDynamoOrganizationId = '';
    let createdCosmosUserId = '';
    let createdDynamoUserId = '';
    let userToken: any = null;
    let organization: Record<string, any> = {};

    user.id = newUserId;

    try {

        if (_track) console.log('Check existing users.', {user});
        const existingUsers = await getUserOrgs(user.email, user.mobile);

        if (!isNil(organizationId) && find(existingUsers, (u) => u.organizationId == organizationId)) 
        {
            throw {
                ...HTTPERROR_400,
                type: 'ERROR_API_USEREXISTS',
                source,
                detail: {
                    parameters: { email: user.email, mobile: user.mobile }
                }
            }
        }

        context = { ...context, userId: newUserId, organizationId };

        //If the new organizationId is provided, it means we will create a new organization
        if (newOrganizationId) {
            //create organization in cosmosDb
            createdCosmosOrganizationId = newOrganizationId;

            if (_track) console.log('Create new organization in the CosmsDB.', {createdCosmosOrganizationId});

            organization = await createRecord(
                context,
                {
                    id: createdCosmosOrganizationId,
                    entityName: "Organization",
                    name: 'My Organization',
                    solutionId: solution.id,
                    disableDelete: true
                }, { skipSecurityCheck: true });

            //create organization in dynamoDb
            const createdDynamoOrganizationId = `organization.${createdCosmosOrganizationId}`;

            if (_track) console.log('Create new organization in the DynamoDB.', {createdDynamoOrganizationId});
            await dynamoDBCreate({ ...organization, id: createdDynamoOrganizationId }, DYNAMO_DB_TABLE_NAME_PROFILE);

            //context.organization = organization;
            context.organizationId = createdCosmosOrganizationId;
        }

        user.organizationId = context.organizationId;
        user.key = serialNumber();
        user.entityName = "User";
        user.emailVerificationCode = newGuid().split("-")[0].toUpperCase();
        user.mobileVerificationCode = newGuid().split("-")[0].toUpperCase();
        user.disableDelete = true;
        user.createdFromDomain = getDomain(context.event, false);

        context.user = user;
        context.userId = user.id;

        user = await processUpsertData(context, user, {skipExistingData:true});

        //insert user into cosmosDb
        if (_track) console.log('Create new user in the CosmsDB.', {user});
        await cosmosDBUpsert(user);
        createdCosmosUserId = user.id;

        //insert user into dynamoDb
        const createdDynamoUserId = `user.${user.id}`;
        if (_track) console.log('Create new user in the DynamoDB.', {createdDynamoUserId});
        await dynamoDBCreate({ ...user, id: createdDynamoUserId }, DYNAMO_DB_TABLE_NAME_PROFILE);

        const userTokenData = { userId: newUserId, organizationId: newOrganizationId, roles: user.roles, licenses: user.licenses };
        if (_track) console.log('Create new user token.', {userTokenData});
        userToken = await createToken(newUserId, 'user', userTokenData);

        if (_track) console.log('Create new user in Cognito.', {
            userPoolId: solution.auth.cognito.userPoolId,
            userPoolLambdaClientId: solution.auth.cognito.userPoolLambdaClientId,
            organizationId: context.organizationId,
            userId: user.id,
            password: password
        });
        await createCognitoUser(
            solution.auth.cognito.userPoolId,
            solution.auth.cognito.userPoolLambdaClientId,
            context.organizationId,
            user.id,
            password
        );

        return { user, organization };

    } catch (error) {

        if (_track) console.error(error);

        //we will have to rollback what we have done
        if (isNonEmptyString(createdCosmosOrganizationId)) await cosmosDBDelete(organization);
        if (isNonEmptyString(createdDynamoOrganizationId)) await dynamoDBDelete(createdDynamoOrganizationId, DYNAMO_DB_TABLE_NAME_PROFILE);

        if (isNonEmptyString(createdCosmosUserId)) await cosmosDBDelete(user);
        if (isNonEmptyString(createdDynamoUserId)) await dynamoDBDelete(createdDynamoUserId, DYNAMO_DB_TABLE_NAME_PROFILE);

        if (isObject(userToken)) {
            await dynamoDBDelete(`tokens.${createdCosmosUserId}`, DYNAMO_DB_TABLE_NAME_PROFILE);
        }

        throw {
            ...HTTPERROR_400,
            type: 'ERROR_API_CREATE_USER',
            source,
            detail: {
                error
            }
        }
    }
};


export const updateUser = async (context: Record<string,any>, user: Record<string,any>): Promise<Record<string,any>> => {

    const source = 'updateUser';
  
    if (!(isObject(user) && isNonEmptyString(user.id)))
    {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source,
            detail: {
                reason: 'user.id'
            }
        }
    }

    if (user.entityName != 'User') {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source,
            detail: {
                reason: 'user.entityName="User"'
            }
        }
    }

    const newRoles = isArray(user.roles) ? [...user.roles] : [];
    const newLicenses = isArray(user.licenses) ? [...user.licenses] : [];

    //updateRecord function will not change roles and licenses
    const newUser = await updateRecord(context, user);

    const existingRoles = isArray(newUser.roles) ? newUser.roles : [];
    const existingLicenses = isArray(newUser.licenses) ? newUser.licenses : [];

    //Only the user with the correct role can change the role and licenses of a user
    if (JSON.stringify(newRoles)!=(JSON.stringify(existingRoles)) || 
    JSON.stringify(newLicenses)!=(JSON.stringify(existingLicenses)))
    {
        let updateRolesAndLicenses = false;
        if (hasRole(context, 'ORG-ADMIN', newUser) || hasRole(context, 'USER-MANAGER', newUser))
        {
            updateRolesAndLicenses = true;
            newUser.roles = newRoles;
            newUser.licenses = newLicenses;
        }

        if (hasRole(context, 'ROLE-MANAGER', newUser))
        {
            updateRolesAndLicenses = true;
            newUser.roles = newRoles;
        }

        if (hasRole(context, 'LICENSE-MANAGER', newUser))
        {
            updateRolesAndLicenses = true;
            newUser.licenses = newLicenses;
        }

        if (updateRolesAndLicenses) await cosmosDBUpdate(newUser);
    }

    await dynamoDBUpsert({...newUser,  id: `user.${newUser.id}` }, DYNAMO_DB_TABLE_NAME_PROFILE, true);

    return newUser;
}

//We do not delete any user in our platform, just simply change stateCode=-1;
export const deleteUser = async (context: Record<string,any>, id: string, statusCode?:number): Promise<Record<string,any>> => {

    const source = 'deleteUser';
  
    if (!isNonEmptyString(id))
    {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source,
            detail: {
                reason: 'id'
            }
        }
    }

    const user = await cosmosDBRetrieve(id);
    if (!user || user && user.entityName != 'User') {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source,
            detail: {
                reason: 'The user does not exist'
            }
        }
    }

    if (!(hasRole(context, 'ORG-ADMIN', user) || hasRole(context, 'USER-MANAGER', user)))
    {
        throw {
            ...HTTPERROR_403,
            type: ERROR_PERMISSION_DENIED,
            source,
            detail: {
                reason: 'user.entityName="User"'
            }
        }
    }

    if (!(statusCode && isNumber(statusCode) && statusCode<0)) statusCode=-1;

    await cosmosDBUpdate({...user, stateCode:-1, statusCode})
    await dynamoDBUpsert({...user,  id: `user.${user.id}` }, DYNAMO_DB_TABLE_NAME_PROFILE, true);

    return user;
}

// export const deleteUser = async (context, id) => {

//     const { organizationId, userId } = context;
//     const toDeleteUserId = id;

//     if (sameGuid(toDeleteUserId, userId)) {
//         throw ('ERROR_API_DELETE_USER_DELETE_SELF', { statusCode: 403, message: 'User can not delete self.' });
//     }

//     const toDeleteUser = await cosmosDBRetrieve(toDeleteUserId);

//     if (!(isObject(toDeleteUser) && toDeleteUser.id)) {
//         throw ('ERROR_API_DELETE_USER_NOT_EXISTS', { statusCode: 400, toDeleteUserId });
//     }

//     const curUserIsRootAdmin = !hasRole(context, 'SOLUTION-ADMIN');
//     const curUserIsOrgAdmin = hasRole(context, 'ORG-ADMIN') && sameGuid(toDeleteUser.organizationId, organizationId);

//     if (!curUserIsRootAdmin && !curUserIsOrgAdmin) {
//         return throw ('ERROR_API_DELETE_USER_NEED_ORG_ROOT_ADMIN',
//         {
//             statusCode: 403,
//             message: `Only the user with ORG-ADMIN or SOLUTION-ADMIN role can delete the user (${toDeleteUserId}).`
//         });
//     }

//     const toDeleteUserOrganizationId = toDeleteUser.organizationId;
//     const toDeleteUserOrganization = await cosmosDBRetrieve(toDeleteUserOrganizationId);

//     const isDeletingOwnerOfOrganization = sameGuid(toDeleteUserOrganization.ownedBy, id);
//     if (isDeletingOwnerOfOrganization && !curUserIsRootAdmin) {
//         return throw ('ERROR_API_DELETE_USER_NEED_ROOT_ADMIN',
//         {
//             statusCode: 403,
//             message: `Only the user with SOLUTION-ADMIN role can delete the organization owner (${toDeleteUserId}).`
//         });
//     }

//     //find the records owned, created or modified by the user
//     //We only delete non-dependency user that has only two records associated to the user
//     //One record is the organization created for the user and the other is the user record itself
//     const userData = await cosmosDBQuery(
//         `SELECT TOP 1 c.id FROM c WHERE c.id NOT IN (@orgId,@userId) AND (c.createdBy=@userId OR c.ownedBy=@userId OR c.modifiedBy=@userId)`,
//         [
//             {
//                 name: '@userId',
//                 value: toDeleteUserId
//             },
//             {
//                 name: '@orgId',
//                 value: toDeleteUserOrganizationId
//             }
//         ]);


//     //we need to make sure the user does not have associated records
//     if (userData.length > 0) {
//         return throw ('ERROR_API_USER_DELETE_USERHASDATA', {
//             statusCode: 400,
//             message: `There are data depending on the user (${toDeleteUserId}), the user can not be deleted.`
//         });
//     }

//     let deleteOrg = false;

//     //If the user created by him/herself, it means this is the owner of the organization or the first user of the organization
//     if (isDeletingOwnerOfOrganization || sameGuid(toDeleteUser.id, toDeleteUser.createdBy)) {
//         //Find whether there's other user in the organization 
//         const orgUsers = await cosmosDBQuery(
//             'SELECT c.id FROM c WHERE c.entityName=@entityName AND c.organizationId=@organizationId',
//             [
//                 {
//                     name: '@organizationId',
//                     value: toDeleteUserOrganizationId
//                 },
//                 {
//                     name: '@entityName',
//                     value: 'User'
//                 }
//             ]);


//         if (orgUsers.length == 1) deleteOrg = true;
//     }


//     //Delete Organization
//     if (deleteOrg) {
//         await cosmosDb.deleteRecord(context, toDeleteUserOrganizationId, { skipSecurityCheck: true });
//         await dynamoDb.deleteRecord(`organization.${toDeleteUserOrganizationId}`, DYNAMO_DB_TABLE_NAME_PROFILE);
//     }

//     //Delete User
//     await cosmosDb.deleteRecord(context, toDeleteUserId, { skipSecurityCheck: true });
//     await dynamoDb.deleteRecord(`user.${toDeleteUserId}`, DYNAMO_DB_TABLE_NAME_PROFILE);

//     await _dynamoDb.delete({ TableName: DYNAMO_DB_TABLE_NAME_PROFILE, Key: { id: `tokens.${toDeleteUserId}` } }).promise();

//     //Delete Cognito User
//     await cognito.deleteUser(solution.auth.cognito.userPoolId, toDeleteUserOrganizationId, toDeleteUserId);

//     return { toDeleteUserOrganizationId, toDeleteUserId };

// };

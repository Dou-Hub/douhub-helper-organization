# douhub-helper-organization

## Always throw error
```javascript
throw {
    //http error: it is optional, only required if the called is a lambda function
    ... HTTPERROR_400, 
    //type: suggest to have it for every error
    type: 'ERROR_API_ERROR', 
    //source: keep the module name and function name
    source: 'auth.signIn',
    //message: provide human readable error message. this optional, we should leave the caller to handle it with proper message that may also support multi-langurage 
    message: '',
    //detail: provide helpful data to help understand the error better, it can have any data in it.
    detail: {
        reason: '',
        ...anything
    },
    //error: this is the inner error.
    error
}
```
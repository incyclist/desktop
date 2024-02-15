const RequestForm = require("./impl-requestlib")

const testOpts = {
    url: 'https://www.strava.com/api/v3/uploads',
    auth: { bearer: '_NOT_A_REAL_BEARER' }
}

const uploadInfo =  {
    file: {
    type: 'file',
    fileName: 'testdata/activity.fit'
    },
    activity_type: 'virtualride',
    data_type: 'tcx',
    name: 'Incyclist Ride',
    description: undefined,
    external_id: '2b498cb0-2241-4cf0-9f77-0279adca2851-1702733150888'
}


describe( 'FormPost Feature: RequestLib Implementation',()=>{

    describe ('createForm',()=>{
        test('normal request',async ()=>{
            const c = new RequestForm()
            const res = await c.createForm(testOpts,uploadInfo)
            
            expect(res).toMatchSnapshot()

        })
    })
}) 
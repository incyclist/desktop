const RequestForm = require("./impl-requestlib")
const fs = require('fs/promises')

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

// Mock fs.readFile for tests
jest.mock('fs/promises');

describe('FormPost Feature: RequestLib Implementation', () => {
    beforeEach(() => {
        // Reset all mocks before each test
        jest.clearAllMocks();
    });

    describe('createForm', () => {
        test('normal request', async () => {
            const c = new RequestForm()
            const res = await c.createForm(testOpts, uploadInfo)
            expect(res).toMatchSnapshot()
        })

        test('should use route name from JSON file', async () => {
            // Mock the JSON file content
            const mockJsonContent = JSON.stringify({
                route: {
                    name: 'Test Route Name'
                }
            });
            
            fs.readFile.mockImplementation((path, encoding) => {
                if (path.endsWith('.json')) {
                    return Promise.resolve(mockJsonContent);
                }
                return Promise.resolve('mock file content');
            });

            const testUploadInfo = {
                ...uploadInfo,
                file: {
                    type: 'file',
                    fileName: 'testdata/activity.tcx'
                }
            };

            const c = new RequestForm();
            const res = await c.createForm(testOpts, testUploadInfo);

            // Verify the name was updated with the route name and suffix
            expect(res.formData.name).toBe('Test Route Name - Incyclist Ride');
        });

        test('should fallback to default name if JSON file not found', async () => {
            // Mock fs.readFile to throw an error
            fs.readFile.mockRejectedValue(new Error('File not found'));

            const testUploadInfo = {
                ...uploadInfo,
                file: {
                    type: 'file',
                    fileName: 'testdata/activity.tcx'
                }
            };

            const c = new RequestForm();
            const res = await c.createForm(testOpts, testUploadInfo);

            // Verify fallback to default name
            expect(res.formData.name).toBe('Incyclist Ride');
        });
    })
}) 
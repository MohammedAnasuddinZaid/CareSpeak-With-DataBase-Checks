import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — CareSpeak",
  description:
    "How CareSpeak handles patient accounts, health data, sessions, cookies, audit logs, and retention",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[#f9f7f5]">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-24">
        <h1 className="text-4xl font-bold text-[#1f1f1f] mb-8">Privacy Policy</h1>
        <div className="card p-8 text-sm text-[#6e6e6e] leading-relaxed space-y-4">
          <p><strong>Last updated:</strong> September 2026</p>

          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900">
            <p className="font-semibold">Deployment notice</p>
            <p className="mt-1">
              CareSpeak handles identifiable patient health information. The statements below
              describe the reference implementation. A deployment is only compliant if its
              operator has also configured a lawful basis or patient consent, retention
              schedule, data-processing agreement with the hospital, and the applicable
              national health-records rules (for example India&apos;s DPDP Act 2023 and the
              ABHA/EHR guidance). Shipping this software does not by itself make a deployment
              lawful.
            </p>
          </div>

          <h2 className="text-lg font-semibold text-[#1f1f1f] mt-6">On-device processing</h2>
          <p>
            Camera-based assistive features are processed entirely in your browser using
            WebAssembly (MediaPipe). Video frames and images are never transmitted to any
            CareSpeak server, and no analytics or tracking scripts run on this site.
          </p>

          <h2 className="text-lg font-semibold text-[#1f1f1f] mt-6">What we do store</h2>
          <p>
            CareSpeak maintains user accounts and a clinical record. When an organisation uses
            the nurse, ward, reporting, and bedside-console features, the following is stored
            on the CareSpeak server:
          </p>
          <ul className="list-disc pl-5 space-y-2">
            <li>
              <strong>Identity and access:</strong> email address, display name, role (patient,
              nurse, doctor, admin), password hash, one-time-login codes, session records, and
              optional Google OAuth link.
            </li>
            <li>
              <strong>Patient record:</strong> patient profile, admission, bed assignment, care
              assignments, and recorded consent status.
            </li>
            <li>
              <strong>Clinical observations:</strong> vital-sign samples (heart rate, SpO₂,
              temperature, battery, signal), pain and comfort assessments, care tasks,
              medication-administration records, personalised vital baselines, and derived alerts.
            </li>
            <li>
              <strong>Communication:</strong> quick-phrase and dictated messages between patients
              and staff, with their timestamps.
            </li>
            <li>
              <strong>Devices and pairing:</strong> bedside-console codes and wearable pairing
              records tied to a bed.
            </li>
            <li>
              <strong>Security and audit:</strong> an append-only, tamper-evident audit log
              recording who did what and when, including sign-in events, role changes, and record
              access, together with the request IP address and browser user-agent.
            </li>
          </ul>
          <p>
            This is sensitive personal health information. It is not sold, and it is not used for
            advertising or profiling.
          </p>

          <h2 className="text-lg font-semibold text-[#1f1f1f] mt-6">Cookies</h2>
          <p>CareSpeak sets only the cookies required to keep you signed in and to hold state:</p>
          <ul className="list-disc pl-5 space-y-2">
            <li>
              <code className="text-xs">cs_at</code> — short-lived access token for API calls.
            </li>
            <li>
              <code className="text-xs">cs_rt</code> — rotating refresh token, scoped to
              <code className="text-xs"> /api/auth</code> so it is not sent with ordinary
              requests.
            </li>
            <li>
              <code className="text-xs">cs_console</code> — time-boxed bedside-console credential
              after a staff PIN unlock.
            </li>
            <li>
              <code className="text-xs">cs_google_flow</code> — temporary sign-in state, deleted
              as soon as the flow finishes.
            </li>
          </ul>
          <p>
            All are strictly necessary, set <code className="text-xs">HttpOnly</code> and
            <code className="text-xs"> SameSite=Lax</code>, and marked
            <code className="text-xs"> Secure</code> on HTTPS deployments. There are no
            advertising, analytics, or third-party tracking cookies.
          </p>

          <h2 className="text-lg font-semibold text-[#1f1f1f] mt-6">Who can see clinical data</h2>
          <p>
            Access is role-based. Patients see their own record; clinical staff see only patients
            they are actively assigned to, and that access is withdrawn when the assignment ends.
            Every access to a patient record is written to the audit log.
          </p>

          <h2 className="text-lg font-semibold text-[#1f1f1f] mt-6">Email</h2>
          <p>
            If email sign-in is enabled, a one-time code is sent to the address on the account
            through the SMTP relay configured by the operator. CareSpeak does not send
            marketing email.
          </p>

          <h2 className="text-lg font-semibold text-[#1f1f1f] mt-6">Camera access</h2>
          <p>
            Camera access is requested solely for on-device gesture and face detection. The video
            stream never leaves your browser, and you can revoke camera permission at any time
            in your browser settings.
          </p>

          <h2 className="text-lg font-semibold text-[#1f1f1f] mt-6">Retention and deletion</h2>
          <p>
            Session and one-time-code records are deleted or expire shortly after use. Clinical
            retention periods are set by the operating hospital and its legal obligations, not by
            this software; the operator is responsible for applying them and for honouring erasure
            and correction requests.
          </p>

          <h2 className="text-lg font-semibold text-[#1f1f1f] mt-6">Security</h2>
          <p>
            Passwords and console PINs are stored as salted scrypt hashes. Tokens are stored
            hashed, compared in constant time, rotated on refresh, and revoked on reuse. Clinical
            writes are recorded in a hash-chained audit log that detects edits and deletions. No
            system is perfectly secure, and CareSpeak should not be treated as a substitute for
            the safeguards a hospital is required to maintain.
          </p>

          <h2 className="text-lg font-semibold text-[#1f1f1f] mt-6">Contact</h2>
          <p>
            For privacy-related questions or to exercise your access, correction, or erasure
            rights, contact the hospital or organisation operating this CareSpeak deployment, or
            raise an issue on the project&apos;s public repository.
          </p>
        </div>
      </div>
    </div>
  );
}
